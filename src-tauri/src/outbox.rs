use crate::{
    attachments, folders,
    mail::{self, Account, Credentials, Draft},
    Result,
};
use lettre::Transport;
use mail_store::Store;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Sending,
    Uncertain,
    Rejected,
    CopyPending,
    Complete,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub draft: Draft,
    pub status: Status,
    pub sent_folder: String,
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    raw: Vec<u8>,
}

pub fn draft_prefix(account: &str) -> String {
    format!("draft-v2:{account}:")
}
pub fn draft_key(account: &str, id: &str) -> String {
    format!("{}{id}", draft_prefix(account))
}
pub fn prefix(account: &str) -> String {
    format!("outbox-v1:{account}:")
}
fn key(account: &str, id: &str) -> String {
    format!("{}{id}", prefix(account))
}
fn valid(draft: &Draft) -> Result<()> {
    uuid::Uuid::parse_str(&draft.id).map_err(|_| "Ungültige Entwurfs-ID.")?;
    if draft.body.len() + draft.to.len() + draft.subject.len() > 11 * 1024 * 1024 {
        return Err("Entwurf ist zu groß.".into());
    }
    Ok(())
}
pub fn check_editable(store: &Store, account: &str, draft: &Draft) -> Result<()> {
    valid(draft)?;
    if store
        .get::<Submission>(&key(account, &draft.id))
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err(
            "Dieser Entwurf wurde bereits zum Versand übergeben. Bitte Versandverlauf öffnen."
                .into(),
        );
    }
    Ok(())
}
pub fn save_draft(store: &Store, account: &str, draft: &Draft) -> Result<()> {
    check_editable(store, account, draft)?;
    attachments::validate_refs(store, account, &draft.attachments)?;
    let key = draft_key(account, &draft.id);
    let old = store.get::<Draft>(&key).map_err(|e| e.to_string())?;
    if old
        .as_ref()
        .is_some_and(|old| old.revision > draft.revision)
    {
        return Ok(());
    }
    if old
        .as_ref()
        .is_some_and(|old| old.revision == draft.revision && old != draft)
    {
        return Err("Der Entwurf wurde inzwischen geändert. Bitte erneut öffnen.".into());
    }
    let mut changes = if let Some(old) = old {
        attachments::removals(
            store,
            account,
            &draft.id,
            &old.attachments,
            &draft.attachments,
        )?
    } else {
        vec![]
    };
    changes.push((key, Some(serde_json::to_vec(draft).unwrap())));
    store.batch(&changes).map_err(|e| e.to_string())
}
pub fn delete_draft(store: &Store, account: &str, id: &str) -> Result<()> {
    let key = draft_key(account, id);
    let mut changes = if let Some(old) = store.get::<Draft>(&key).map_err(|e| e.to_string())? {
        attachments::removals(store, account, id, &old.attachments, &[])?
    } else {
        vec![]
    };
    changes.push((key, None));
    store.batch(&changes).map_err(|e| e.to_string())
}

pub fn drafts(store: &Store, account: &str) -> Result<Vec<Draft>> {
    // One-time migration from the original single-draft slot, atomically with its removal.
    let legacy_key = format!("draft-v1:{account}");
    if let Some(Some(draft)) = store
        .get::<Option<Draft>>(&legacy_key)
        .map_err(|e| e.to_string())?
    {
        store
            .batch(&[
                (
                    draft_key(account, &draft.id),
                    Some(serde_json::to_vec(&draft).unwrap()),
                ),
                (legacy_key, None),
            ])
            .map_err(|e| e.to_string())?;
    }
    store
        .scan(&draft_prefix(account))
        .map_err(|e| e.to_string())
}
pub fn history(store: &Store, account: &str) -> Result<Vec<Submission>> {
    let mut entries = store
        .scan::<Submission>(&prefix(account))
        .map_err(|e| e.to_string())?;
    for entry in &mut entries {
        if entry.status == Status::Sending {
            entry.status = Status::Uncertain;
        }
        // MIME bytes remain private to the backend.
        entry.raw.clear();
    }
    Ok(entries)
}

// Injectable boundary: tests model lost acknowledgements and restarts without sending mail.
pub trait Delivery {
    fn prepare(&mut self, draft: &Draft, target: &str) -> Result<Vec<u8>>;
    fn submit(&mut self, draft: &Draft, raw: &[u8]) -> std::result::Result<(), (Status, String)>;
    fn copy(&mut self, draft: &Draft, raw: &[u8], target: &str) -> Result<()>;
}
pub struct Network<'a>(pub &'a Credentials, pub &'a Store);
impl Delivery for Network<'_> {
    fn prepare(&mut self, draft: &Draft, target: &str) -> Result<Vec<u8>> {
        let files = attachments::load(self.1, &self.0.account.identity(), &draft.attachments)?;
        let raw = mail::build_message(&self.0.account, draft, &files)?.formatted();
        if raw.len() > mail::MAX_MESSAGE as usize {
            return Err(
                "Die vollständige Nachricht einschließlich Anhängen ist größer als 25 MiB.".into(),
            );
        }
        let mut session = mail::connect(self.0)?;
        mail::validate_folder(target)?;
        session
            .examine(target)
            .map_err(|_| "Bitte einen vorhandenen Gesendet-Ordner auswählen.")?;
        let _ = session.logout();
        Ok(raw)
    }
    fn submit(&mut self, draft: &Draft, raw: &[u8]) -> std::result::Result<(), (Status, String)> {
        let envelope = mail::envelope(&self.0.account, draft).map_err(|e| (Status::Rejected, e))?;
        let smtp = mail::smtp(self.0).map_err(|e| (Status::Rejected, e))?;
        smtp.send_raw(&envelope, raw).map(|_| ()).map_err(|e| {
            if e.status().is_some() { (Status::Rejected, "SMTP hat die Nachricht abgelehnt. Es wurde keine Annahme bestätigt.".into()) }
            else { (Status::Uncertain, "Versandstatus unklar. Vor einem erneuten Versand beim Empfänger oder Server prüfen.".into()) }
        })
    }
    fn copy(&mut self, draft: &Draft, raw: &[u8], target: &str) -> Result<()> {
        let mut session = mail::connect(self.0)?;
        folders::append_on(&mut session, target, &draft.id, raw)?;
        let _ = session.logout();
        Ok(())
    }
}

pub fn send(
    store: &Store,
    account: &Account,
    draft: Draft,
    target: String,
    delivery: &mut impl Delivery,
) -> Result<Submission> {
    valid(&draft)?;
    let identity = account.identity();
    let key = key(&identity, &draft.id);
    let existing = store.get::<Submission>(&key).map_err(|e| e.to_string())?;
    let mut entry = if let Some(mut old) = existing {
        if old.status == Status::Sending {
            old.status = Status::Uncertain;
        }
        if old.status != Status::CopyPending {
            old.raw.clear();
            return Ok(old);
        }
        old
    } else {
        if store
            .get::<Draft>(&draft_key(&identity, &draft.id))
            .map_err(|e| e.to_string())?
            .is_some_and(|old| old.revision > draft.revision)
        {
            return Err("Der Entwurf wurde inzwischen geändert. Bitte erneut öffnen.".into());
        }
        save_draft(store, &identity, &draft)?;
        let raw = delivery.prepare(&draft, &target)?;
        let mut entry = Submission {
            draft,
            status: Status::Sending,
            sent_folder: target,
            detail: None,
            raw,
        };
        // A durable in-flight marker precedes SMTP. On crash it becomes uncertain, never retryable.
        store
            .batch(&[
                (key.clone(), Some(serde_json::to_vec(&entry).unwrap())),
                (draft_key(&identity, &entry.draft.id), None),
            ])
            .map_err(|e| e.to_string())?;
        match delivery.submit(&entry.draft, &entry.raw) {
            Ok(()) => entry.status = Status::CopyPending,
            Err((status, detail)) => {
                entry.status = status;
                entry.detail = Some(detail);
            }
        }
        // If this commit fails, the durable Sending record still blocks another SMTP attempt.
        store.put(&key, &entry).map_err(|_| "Versandstatus konnte nicht gespeichert werden. Nicht erneut senden; Versandverlauf prüfen.")?;
        entry
    };
    if entry.status == Status::CopyPending {
        match delivery.copy(&entry.draft, &entry.raw, &entry.sent_folder) {
            Ok(()) => {
                entry.status = Status::Complete;
                entry.detail = None;
                entry.raw.clear();
            }
            Err(detail) => {
                entry.detail = Some(detail);
            }
        }
        store.put(&key, &entry).map_err(|_| "Nachricht gesendet. Kopierstatus konnte nicht gespeichert werden; Versandverlauf prüfen.")?;
    }
    entry.raw.clear();
    Ok(entry)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    struct Fake {
        smtp: usize,
        copies: usize,
        fail_copy: bool,
        uncertain: bool,
    }
    impl Delivery for Fake {
        fn prepare(&mut self, _: &Draft, _: &str) -> Result<Vec<u8>> {
            Ok(b"same MIME bytes".to_vec())
        }
        fn submit(&mut self, _: &Draft, raw: &[u8]) -> std::result::Result<(), (Status, String)> {
            self.smtp += 1;
            assert_eq!(raw, b"same MIME bytes");
            if self.uncertain {
                Err((Status::Uncertain, "lost response".into()))
            } else {
                Ok(())
            }
        }
        fn copy(&mut self, _: &Draft, raw: &[u8], _: &str) -> Result<()> {
            self.copies += 1;
            assert_eq!(raw, b"same MIME bytes");
            if self.fail_copy {
                Err("offline".into())
            } else {
                Ok(())
            }
        }
    }
    pub(crate) fn draft() -> Draft {
        Draft {
            id: mail::new_id(),
            revision: 1,
            attachments: vec![],
            sent_folder: Some("Custom Sent".into()),
            to: "a@example.org".into(),
            subject: "Hello".into(),
            body: "Saved text".into(),
        }
    }
    #[test]
    fn copy_retry_after_reopen_never_resends_smtp_or_resurrects_draft() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.redb");
        let account = mail::tests::account();
        let draft = draft();
        let mut fake = Fake {
            smtp: 0,
            copies: 0,
            fail_copy: true,
            uncertain: false,
        };
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(
                send(&store, &account, draft.clone(), "Sent".into(), &mut fake)
                    .unwrap()
                    .status,
                Status::CopyPending
            );
            assert!(save_draft(&store, &account.identity(), &draft).is_err());
            assert!(drafts(&store, &account.identity()).unwrap().is_empty());
        }
        let store = Store::open(&path).unwrap();
        fake.fail_copy = false;
        assert_eq!(
            send(&store, &account, draft.clone(), "ignored".into(), &mut fake)
                .unwrap()
                .status,
            Status::Complete
        );
        send(&store, &account, draft, "Sent".into(), &mut fake).unwrap();
        assert_eq!((fake.smtp, fake.copies), (1, 2));
    }
    #[test]
    fn uncertain_or_interrupted_delivery_cannot_be_retried() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.redb")).unwrap();
        let account = mail::tests::account();
        let draft = draft();
        let mut fake = Fake {
            smtp: 0,
            copies: 0,
            fail_copy: false,
            uncertain: true,
        };
        for _ in 0..2 {
            assert_eq!(
                send(&store, &account, draft.clone(), "Sent".into(), &mut fake)
                    .unwrap()
                    .status,
                Status::Uncertain
            );
        }
        assert_eq!((fake.smtp, fake.copies), (1, 0));
        let key = key(&account.identity(), &draft.id);
        let mut entry: Submission = store.get(&key).unwrap().unwrap();
        entry.status = Status::Sending;
        store.put(&key, &entry).unwrap();
        assert_eq!(
            send(&store, &account, draft, "Sent".into(), &mut fake)
                .unwrap()
                .status,
            Status::Uncertain
        );
        assert_eq!(fake.smtp, 1);
    }
    #[test]
    fn older_autosave_cannot_overwrite_newer_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.redb")).unwrap();
        let mut draft = draft();
        draft.revision = 5;
        save_draft(&store, "account", &draft).unwrap();
        draft.revision = 2;
        draft.body = "stale".into();
        save_draft(&store, "account", &draft).unwrap();
        assert_eq!(drafts(&store, "account").unwrap()[0].body, "Saved text");
        assert_eq!(
            drafts(&store, "account").unwrap()[0].sent_folder.as_deref(),
            Some("Custom Sent")
        );
        assert!(drafts(&store, "another").unwrap().is_empty());
    }
    #[test]
    fn old_single_draft_migrates_once_and_keeps_other_drafts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.redb");
        {
            let store = Store::open(&path).unwrap();
            store.put("draft-v1:account", &serde_json::json!({"to":"old@example.org", "subject":"Legacy", "body":"Original text"})).unwrap();
            save_draft(&store, "account", &draft()).unwrap();
            let migrated = drafts(&store, "account").unwrap();
            assert_eq!(migrated.len(), 2);
            assert!(migrated.iter().any(|d| d.subject == "Legacy"
                && d.body == "Original text"
                && uuid::Uuid::parse_str(&d.id).is_ok()));
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(drafts(&store, "account").unwrap().len(), 2);
        assert!(store
            .get::<serde_json::Value>("draft-v1:account")
            .unwrap()
            .is_none());
    }
    #[test]
    fn attachment_copy_retry_uses_persisted_mime_after_restart() {
        struct AttachmentDelivery {
            raw: Vec<u8>,
            fail_copy: bool,
            smtp: usize,
        }
        impl Delivery for AttachmentDelivery {
            fn prepare(&mut self, _: &Draft, _: &str) -> Result<Vec<u8>> {
                Ok(self.raw.clone())
            }
            fn submit(
                &mut self,
                _: &Draft,
                raw: &[u8],
            ) -> std::result::Result<(), (Status, String)> {
                assert_eq!(raw, self.raw);
                self.smtp += 1;
                Ok(())
            }
            fn copy(&mut self, _: &Draft, raw: &[u8], _: &str) -> Result<()> {
                assert_eq!(mail::decode_parts(raw).unwrap().1[0].data, [0, 255, 42]);
                if self.fail_copy {
                    Err("lost append response".into())
                } else {
                    Ok(())
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.redb");
        let account = mail::tests::account();
        let id = account.identity();
        let saved;
        let mut delivery = AttachmentDelivery {
            raw: vec![],
            fail_copy: true,
            smtp: 0,
        };
        {
            let store = Store::open(&path).unwrap();
            saved = attachments::add_files(
                &store,
                &id,
                draft(),
                vec![attachments::Content {
                    name: "data.bin".into(),
                    data: vec![0, 255, 42],
                }],
            )
            .unwrap();
            let mut stale = saved.clone();
            stale.revision -= 1;
            assert!(send(&store, &account, stale, "Sent".into(), &mut delivery).is_err());
            assert_eq!(delivery.smtp, 0);
            delivery.raw = mail::build_message(
                &account,
                &saved,
                &attachments::load(&store, &id, &saved.attachments).unwrap(),
            )
            .unwrap()
            .formatted();
            assert_eq!(
                send(
                    &store,
                    &account,
                    saved.clone(),
                    "Sent".into(),
                    &mut delivery
                )
                .unwrap()
                .status,
                Status::CopyPending
            );
        }
        let store = Store::open(&path).unwrap();
        delivery.raw.clear(); // retry must not call prepare or submit again
        delivery.fail_copy = false;
        assert_eq!(
            send(&store, &account, saved, "Sent".into(), &mut delivery)
                .unwrap()
                .status,
            Status::Complete
        );
        let retained = history(&store, &id).unwrap()[0].draft.clone();
        let mut copy = retained.clone();
        copy.id = mail::new_id();
        save_draft(&store, &id, &copy).unwrap();
        delete_draft(&store, &id, &copy.id).unwrap();
        assert_eq!(
            attachments::load(&store, &id, &retained.attachments).unwrap()[0].data,
            [0, 255, 42]
        );
        assert_eq!(delivery.smtp, 1);
    }
}
