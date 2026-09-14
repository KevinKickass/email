mod folders;
mod mail;
mod outbox;
mod settings;
use mail::{Account, Credentials, Draft, Folder, Mail, Snapshot};
use mail_store::Store;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub(crate) type Result<T> = std::result::Result<T, String>;
pub(crate) struct Backend {
    store: Store,
    credentials: Mutex<Option<Credentials>>,
    operation: Mutex<()>,
}

impl Backend {
    fn account(&self) -> Result<Account> {
        self.store
            .get("account-v1")
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Bitte verbinden Sie zuerst Ihr Konto.".into())
    }
    fn credentials(&self) -> Result<Credentials> {
        let mut current = self
            .credentials
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        if let Some(c) = current.as_ref() {
            return Ok(c.clone());
        }
        let account = self.account()?;
        if !account.remember_password {
            return Err("Bitte verbinden Sie zuerst Ihr Konto.".into());
        }
        let c = Credentials::resolve(account, String::new(), String::new())?;
        *current = Some(c.clone());
        Ok(c)
    }
    fn check_account(&self, identity: &str) -> Result<Account> {
        let account = self.account()?;
        if account.identity() != identity {
            return Err("Das aktive Konto hat sich geändert. Bitte erneut öffnen.".into());
        }
        Ok(account)
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "Der Hintergrundauftrag wurde unterbrochen.".to_string())?
}

#[tauri::command]
async fn load_account(state: tauri::State<'_, Arc<Backend>>) -> Result<Option<Account>> {
    let state = Arc::clone(&state);
    blocking(move || {
        state
            .store
            .get("account-v1")
            .map_err(|e| format!("Kontoeinstellungen konnten nicht gelesen werden: {e}"))
    })
    .await
}

#[tauri::command]
async fn connect_account(
    state: tauri::State<'_, Arc<Backend>>,
    account: Account,
    password: String,
    smtp_password: String,
) -> Result<Vec<Folder>> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        account.validate()?;
        let credentials = Credentials::resolve(account, password, smtp_password)?;
        let folders = mail::folders(&credentials)?;
        mail::test_smtp(&credentials)?;
        credentials.persist()?;
        state
            .store
            .batch(&[
                (
                    "account-v1".into(),
                    Some(serde_json::to_vec(&credentials.account).unwrap()),
                ),
                (
                    format!("folders-v1:{}", credentials.account.identity()),
                    Some(serde_json::to_vec(&folders).unwrap()),
                ),
            ])
            .map_err(|e| format!("Konto konnte nicht gespeichert werden: {e}"))?;
        *state
            .credentials
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")? = Some(credentials);
        Ok(folders)
    })
    .await
}

#[tauri::command]
async fn list_messages(state: tauri::State<'_, Arc<Backend>>, folder: String) -> Result<Snapshot> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state.operation.lock().map_err(|_| "Kontozustand nicht verfügbar.")?;
        let account = state.account()?;
        let key = snapshot_key(&account.identity(), &folder);
        match state.credentials().and_then(|c| mail::list(&c, &folder)) {
            Ok(snapshot) => {
                state.store.put(&key, &snapshot).map_err(|e| format!("Nachrichten wurden empfangen, konnten aber nicht lokal gespeichert werden: {e}"))?;
                Ok(snapshot)
            }
            Err(error) => match state.store.get::<Snapshot>(&key).map_err(|e| e.to_string())? {
                Some(mut cached) => { cached.offline = true; cached.warning = Some(error); Ok(cached) }
                None => Err(error),
            }
        }
    }).await
}

#[tauri::command]
async fn read_message(
    state: tauri::State<'_, Arc<Backend>>,
    folder: String,
    uid: u32,
    uid_validity: u32,
) -> Result<Mail> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        let account = state.account()?;
        let key = mail_store::message_key(&account.identity(), &folder, uid_validity, uid);
        if let Some(cached) = state.store.get::<Mail>(&key).map_err(|e| e.to_string())? {
            return Ok(cached);
        }
        let credentials = state.credentials()?;
        let mail = mail::read(&credentials, &folder, uid, uid_validity)?;
        state
            .store
            .put(&key, &mail)
            .map_err(|e| format!("Nachricht konnte nicht gespeichert werden: {e}"))?;
        Ok(mail)
    })
    .await
}

#[tauri::command]
async fn set_flag(
    state: tauri::State<'_, Arc<Backend>>,
    folder: String,
    uid: u32,
    uid_validity: u32,
    kind: String,
    value: bool,
) -> Result<()> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        let credentials = state.credentials()?;
        mail::set_flag(&credentials, &folder, uid, uid_validity, &kind, value)?;
        let identity = credentials.account.identity();
        let snapshot_key = snapshot_key(&identity, &folder);
        let body_key = mail_store::message_key(&identity, &folder, uid_validity, uid);
        let update = |m: &mut Mail| {
            if kind == "seen" {
                m.unread = !value;
            } else {
                m.flagged = value;
            }
        };
        let mut changes = vec![];
        if let Some(mut snapshot) = state
            .store
            .get::<Snapshot>(&snapshot_key)
            .map_err(|e| e.to_string())?
        {
            if snapshot.uid_validity == uid_validity {
                if let Some(m) = snapshot.messages.iter_mut().find(|m| m.uid == uid) {
                    update(m);
                }
                changes.push((snapshot_key, Some(serde_json::to_vec(&snapshot).unwrap())));
            }
        }
        if let Some(mut m) = state
            .store
            .get::<Mail>(&body_key)
            .map_err(|e| e.to_string())?
        {
            update(&mut m);
            changes.push((body_key, Some(serde_json::to_vec(&m).unwrap())));
        }
        state.store.batch(&changes).map_err(|e| e.to_string())
    })
    .await
}

fn snapshot_key(account: &str, folder: &str) -> String {
    serde_json::to_string(&("snapshot-v1", account, folder)).unwrap()
}

#[derive(serde::Serialize)]
struct Startup {
    account: Account,
    folders: Vec<Folder>,
    snapshot: Option<Snapshot>,
}
#[tauri::command]
async fn load_startup(state: tauri::State<'_, Arc<Backend>>) -> Result<Option<Startup>> {
    let state = Arc::clone(&state);
    blocking(move || {
        let Some(account) = state
            .store
            .get::<Account>("account-v1")
            .map_err(|e| e.to_string())?
        else {
            return Ok(None);
        };
        let folders = state
            .store
            .get(&format!("folders-v1:{}", account.identity()))
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| {
                vec![Folder {
                    name: "INBOX".into(),
                    label: "INBOX".into(),
                    selectable: true,
                    role: Some("inbox".into()),
                }]
            });
        let mut snapshot = state
            .store
            .get::<Snapshot>(&snapshot_key(&account.identity(), "INBOX"))
            .map_err(|e| e.to_string())?;
        if let Some(s) = snapshot.as_mut() {
            s.offline = true;
            s.warning = None;
        }
        Ok(Some(Startup {
            account,
            folders,
            snapshot,
        }))
    })
    .await
}

#[tauri::command]
async fn list_folders(state: tauri::State<'_, Arc<Backend>>) -> Result<Vec<Folder>> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        let c = state.credentials()?;
        let folders = mail::folders(&c)?;
        state
            .store
            .put(&format!("folders-v1:{}", c.account.identity()), &folders)
            .map_err(|e| e.to_string())?;
        Ok(folders)
    })
    .await
}

#[tauri::command]
async fn move_message(
    state: tauri::State<'_, Arc<Backend>>,
    folder: String,
    target: String,
    uid: u32,
    uid_validity: u32,
) -> Result<()> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        let c = state.credentials()?;
        let mut session = mail::connect(&c)?;
        let result = folders::move_on(&mut session, &folder, &target, uid, uid_validity);
        let _ = session.logout();
        // Also invalidate after an ambiguous failure; never show a stale cache as authoritative.
        state
            .store
            .batch(&[
                (snapshot_key(&c.account.identity(), &folder), None),
                (snapshot_key(&c.account.identity(), &target), None),
            ])
            .map_err(|e| e.to_string())?;
        result
    })
    .await
}

#[tauri::command]
async fn local_work(
    state: tauri::State<'_, Arc<Backend>>,
    account_id: String,
) -> Result<(Vec<Draft>, Vec<outbox::Submission>)> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        state.check_account(&account_id)?;
        Ok((
            outbox::drafts(&state.store, &account_id)?,
            outbox::history(&state.store, &account_id)?,
        ))
    })
    .await
}
#[tauri::command]
async fn save_draft(
    state: tauri::State<'_, Arc<Backend>>,
    account_id: String,
    draft: Draft,
) -> Result<()> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        state.check_account(&account_id)?;
        outbox::save_draft(&state.store, &account_id, &draft)
    })
    .await
}
#[tauri::command]
async fn delete_draft(
    state: tauri::State<'_, Arc<Backend>>,
    account_id: String,
    id: String,
) -> Result<()> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        state.check_account(&account_id)?;
        state
            .store
            .batch(&[(outbox::draft_key(&account_id, &id), None)])
            .map_err(|e| e.to_string())
    })
    .await
}
#[tauri::command]
async fn send_message(
    state: tauri::State<'_, Arc<Backend>>,
    account_id: String,
    draft: Draft,
    sent_folder: String,
) -> Result<outbox::Submission> {
    let state = Arc::clone(&state);
    blocking(move || {
        let _guard = state
            .operation
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?;
        let account = state.check_account(&account_id)?;
        let c = state.credentials()?;
        outbox::send(
            &state.store,
            &account,
            draft,
            sent_folder,
            &mut outbox::Network(&c),
        )
    })
    .await
}

#[tauri::command]
async fn probe_caldav(url: String) -> Result<String> {
    blocking(move || mail::probe_caldav(&url)).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let store = Store::open(&data.join("email.redb"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(Arc::new(Backend {
                store,
                credentials: Mutex::new(None),
                operation: Mutex::new(()),
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_account,
            connect_account,
            list_messages,
            read_message,
            set_flag,
            load_startup,
            list_folders,
            local_work,
            delete_draft,
            move_message,
            save_draft,
            send_message,
            probe_caldav,
            settings::load_settings,
            settings::save_settings
        ])
        .run(tauri::generate_context!())
        .expect("email konnte nicht gestartet werden");
}
