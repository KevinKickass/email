mod mail;
mod settings;
use mail::{Account, Credentials, Draft, Folder, Mail, Snapshot};
use mail_store::Store;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub(crate) type Result<T> = std::result::Result<T, String>;
pub(crate) struct Backend {
    store: Store,
    credentials: Mutex<Option<Credentials>>,
}

impl Backend {
    fn credentials(&self) -> Result<Credentials> {
        self.credentials
            .lock()
            .map_err(|_| "Kontozustand nicht verfügbar.")?
            .clone()
            .ok_or_else(|| "Bitte verbinden Sie zuerst Ihr Konto.".into())
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
        account.validate()?;
        let credentials = Credentials::resolve(account, password, smtp_password)?;
        let folders = mail::folders(&credentials)?;
        mail::test_smtp(&credentials)?;
        credentials.persist()?;
        state
            .store
            .put("account-v1", &credentials.account)
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
    let credentials = state.credentials()?;
    blocking(move || {
        let key = serde_json::to_string(&("snapshot-v1", credentials.account.identity(), &folder)).unwrap();
        match mail::list(&credentials, &folder) {
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
    let credentials = state.credentials()?;
    blocking(move || {
        let key =
            mail_store::message_key(&credentials.account.identity(), &folder, uid_validity, uid);
        if let Some(cached) = state.store.get::<Mail>(&key).map_err(|e| e.to_string())? {
            return Ok(cached);
        }
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
    let credentials = state.credentials()?;
    blocking(move || mail::set_flag(&credentials, &folder, uid, uid_validity, &kind, value)).await
}

#[tauri::command]
async fn load_draft(state: tauri::State<'_, Arc<Backend>>) -> Result<Option<Draft>> {
    let state = Arc::clone(&state);
    let credentials = state.credentials()?;
    blocking(move || {
        state
            .store
            .get::<Option<Draft>>(&format!("draft-v1:{}", credentials.account.identity()))
            .map(Option::flatten)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn save_draft(state: tauri::State<'_, Arc<Backend>>, draft: Draft) -> Result<()> {
    let state = Arc::clone(&state);
    let credentials = state.credentials()?;
    blocking(move || {
        state
            .store
            .put(
                &format!("draft-v1:{}", credentials.account.identity()),
                &draft,
            )
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
async fn send_message(state: tauri::State<'_, Arc<Backend>>, draft: Draft) -> Result<String> {
    let state = Arc::clone(&state);
    let credentials = state.credentials()?;
    blocking(move || {
        // Persist BEFORE SMTP. A transport failure must not silently discard the user's text.
        let key = format!("draft-v1:{}", credentials.account.identity());
        state.store.put(&key, &draft).map_err(|e| format!("Entwurf konnte nicht gesichert werden: {e}"))?;
        mail::send(&credentials, &draft)?;
        let saved = state.store.put(&key, &Option::<Draft>::None).is_ok();
        Ok(if saved { "SMTP-Server hat die Nachricht angenommen. Noch keine Kopie im IMAP-Ordner „Gesendet“." } else { "SMTP-Server hat die Nachricht angenommen. Der lokale Entwurf konnte nicht entfernt werden; bitte nicht erneut senden." }.into())
    }).await
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
            }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_account,
            connect_account,
            list_messages,
            read_message,
            set_flag,
            load_draft,
            save_draft,
            send_message,
            probe_caldav,
            settings::load_settings,
            settings::save_settings
        ])
        .run(tauri::generate_context!())
        .expect("email konnte nicht gestartet werden");
}
