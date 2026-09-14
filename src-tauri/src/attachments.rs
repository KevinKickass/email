use crate::{
    mail::{self, Draft},
    outbox, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use mail_store::Store;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_FILES: usize = 50;
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct AttachmentRef {
    pub id: String,
    pub name: String,
    pub size: u64,
}
#[derive(Serialize, Deserialize)]
struct Blob {
    name: String,
    data: String,
}
#[derive(Debug)]
pub struct Content {
    pub name: String,
    pub data: Vec<u8>,
}

pub fn safe_name(name: &str) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut clean: String = leaf
        .chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .map(|c| if "<>:\"|?*".contains(c) { '_' } else { c })
        .take(180)
        .collect();
    while clean.len() > 180 {
        clean.pop();
    }
    clean = clean.trim_matches([' ', '.']).to_string();
    if clean.is_empty() {
        clean = "attachment".into();
    }
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CLOCK$"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        clean.insert(0, '_');
    }
    clean
}
fn prefix(account: &str) -> String {
    format!("draft-attachment-v1:{account}:")
}
fn key(account: &str, id: &str) -> String {
    format!("{}{id}", prefix(account))
}
pub fn validate_refs(store: &Store, account: &str, refs: &[AttachmentRef]) -> Result<()> {
    if refs.len() > MAX_FILES {
        return Err("Maximal 50 Anhänge pro Nachricht.".into());
    }
    let mut ids = HashSet::new();
    let mut total = 0u64;
    for attachment in refs {
        uuid::Uuid::parse_str(&attachment.id).map_err(|_| "Ungültige Anhang-ID.")?;
        if !ids.insert(&attachment.id) {
            return Err("Ein Anhang ist doppelt zugeordnet.".into());
        }
        total = total
            .checked_add(attachment.size)
            .ok_or("Anhänge sind zu groß.")?;
        if total > MAX_BYTES as u64 {
            return Err("Anhänge dürfen zusammen höchstens 16 MiB groß sein.".into());
        }
        // Only metadata is read here; large blobs are never rewritten on every keystroke.
        let saved: AttachmentRef = store
            .get(&format!("{}:meta", key(account, &attachment.id)))
            .map_err(|e| e.to_string())?
            .ok_or("Ein lokal gespeicherter Anhang fehlt.")?;
        if saved.name != attachment.name || saved.size != attachment.size {
            return Err("Anhang-Metadaten stimmen nicht überein.".into());
        }
    }
    Ok(())
}
pub fn load(store: &Store, account: &str, refs: &[AttachmentRef]) -> Result<Vec<Content>> {
    validate_refs(store, account, refs)?;
    refs.iter()
        .map(|attachment| {
            let blob: Blob = store
                .get(&key(account, &attachment.id))
                .map_err(|e| e.to_string())?
                .ok_or("Ein lokal gespeicherter Anhang fehlt.")?;
            let data = STANDARD
                .decode(&blob.data)
                .map_err(|_| "Anhang konnte nicht dekodiert werden.")?;
            if data.len() as u64 != attachment.size || blob.name != attachment.name {
                return Err("Anhang-Metadaten stimmen nicht überein.".into());
            }
            Ok(Content {
                name: blob.name,
                data,
            })
        })
        .collect()
}

// Called under Backend.operation. Either all selected files and the updated draft
// commit together, or the existing draft remains unchanged.
pub fn import(store: &Store, account: &str, draft: Draft, paths: &[PathBuf]) -> Result<Draft> {
    validate_refs(store, account, &draft.attachments)?;
    if draft.attachments.len() + paths.len() > MAX_FILES {
        return Err("Maximal 50 Anhänge pro Nachricht.".into());
    }
    let mut total: usize = draft.attachments.iter().map(|a| a.size as usize).sum();
    let mut files = vec![];
    for path in paths {
        if !std::fs::metadata(path)
            .map_err(|_| "Die ausgewählte Datei konnte nicht gelesen werden.")?
            .is_file()
        {
            return Err("Bitte reguläre Dateien als Anhänge auswählen.".into());
        }
        let mut file = std::fs::File::open(path)
            .map_err(|_| "Die ausgewählte Datei konnte nicht gelesen werden.")?;
        let metadata = file
            .metadata()
            .map_err(|_| "Dateigröße konnte nicht gelesen werden.")?;
        if !metadata.is_file() {
            return Err("Bitte reguläre Dateien als Anhänge auswählen.".into());
        }
        let remaining = MAX_BYTES.saturating_sub(total);
        if metadata.len() > remaining as u64 {
            return Err("Anhänge dürfen zusammen höchstens 16 MiB groß sein.".into());
        }
        let mut data = Vec::new();
        (&mut file)
            .take(remaining as u64 + 1)
            .read_to_end(&mut data)
            .map_err(|_| "Die ausgewählte Datei konnte nicht gelesen werden.")?;
        if data.len() > remaining {
            return Err("Anhänge dürfen zusammen höchstens 16 MiB groß sein.".into());
        }
        total += data.len();
        files.push(Content {
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            data,
        });
    }
    add_files(store, account, draft, files)
}

pub fn add_files(
    store: &Store,
    account: &str,
    mut draft: Draft,
    files: Vec<Content>,
) -> Result<Draft> {
    outbox::check_editable(store, account, &draft)?;
    validate_refs(store, account, &draft.attachments)?;
    if store
        .get::<Draft>(&outbox::draft_key(account, &draft.id))
        .map_err(|e| e.to_string())?
        .is_some_and(|old| {
            old.revision > draft.revision || (old.revision == draft.revision && old != draft)
        })
    {
        return Err("Der Entwurf wurde inzwischen geändert. Bitte erneut öffnen.".into());
    }
    if draft.attachments.len() + files.len() > MAX_FILES {
        return Err("Maximal 50 Anhänge pro Nachricht.".into());
    }
    let mut total: usize = draft.attachments.iter().map(|a| a.size as usize).sum();
    let mut changes = vec![];
    for file in files {
        total = total
            .checked_add(file.data.len())
            .ok_or("Anhänge sind zu groß.")?;
        if total > MAX_BYTES {
            return Err("Anhänge dürfen zusammen höchstens 16 MiB groß sein.".into());
        }
        let data = file.data;
        let reference = AttachmentRef {
            id: mail::new_id(),
            name: safe_name(&file.name),
            size: data.len() as u64,
        };
        let blob = Blob {
            name: reference.name.clone(),
            data: STANDARD.encode(data),
        };
        changes.push((
            key(account, &reference.id),
            Some(serde_json::to_vec(&blob).unwrap()),
        ));
        changes.push((
            format!("{}:meta", key(account, &reference.id)),
            Some(serde_json::to_vec(&reference).unwrap()),
        ));
        draft.attachments.push(reference);
    }
    draft.revision = draft
        .revision
        .checked_add(1)
        .ok_or("Entwurfsrevision ist ungültig.")?;
    changes.push((
        outbox::draft_key(account, &draft.id),
        Some(serde_json::to_vec(&draft).unwrap()),
    ));
    store.batch(&changes).map_err(|e| e.to_string())?;
    Ok(draft)
}

// Collect only removed candidates. Other drafts and durable delivery entries can
// share these immutable blobs (for example when reopening rejected mail).
pub fn removals(
    store: &Store,
    account: &str,
    replacing_id: &str,
    old: &[AttachmentRef],
    keep: &[AttachmentRef],
) -> Result<Vec<(String, Option<Vec<u8>>)>> {
    let mut candidates: HashSet<&str> = old.iter().map(|a| a.id.as_str()).collect();
    for a in keep {
        candidates.remove(a.id.as_str());
    }
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    for draft in outbox::drafts(store, account)? {
        if draft.id != replacing_id {
            for a in &draft.attachments {
                candidates.remove(a.id.as_str());
            }
        }
    }
    for entry in outbox::history(store, account)? {
        for a in &entry.draft.attachments {
            candidates.remove(a.id.as_str());
        }
    }
    Ok(candidates
        .into_iter()
        .flat_map(|id| {
            [
                (key(account, id), None),
                (format!("{}:meta", key(account, id)), None),
            ]
        })
        .collect())
}

pub fn cache_key(account: &str, folder: &str, validity: u32, uid: u32) -> String {
    serde_json::to_string(&("raw-message-v1", account, folder, validity, uid)).unwrap()
}
pub fn cached_raw(
    store: &Store,
    account: &str,
    folder: &str,
    validity: u32,
    uid: u32,
) -> Result<Option<Vec<u8>>> {
    store
        .get::<String>(&cache_key(account, folder, validity, uid))
        .map_err(|e| e.to_string())?
        .map(|encoded| {
            STANDARD
                .decode(encoded)
                .map_err(|_| "Nachrichten-Cache konnte nicht dekodiert werden.".into())
        })
        .transpose()
}
// Upgrade cached MIME without credentials or any network access. Keep headers and
// explicit local read/flag changes; only rebuild the body and attachment metadata.
pub fn upgrade_cached(
    store: &Store,
    account: &str,
    folder: &str,
    validity: u32,
    mut message: mail::Mail,
) -> Result<Option<mail::Mail>> {
    if message.body_version == mail::BODY_VERSION {
        return Ok(Some(message));
    }
    let Some(raw) = cached_raw(store, account, folder, validity, message.uid)? else {
        return Ok(None);
    };
    if let Err(error) = mail::populate_body(&mut message, &raw) {
        message.html = None;
        message.links.clear();
        message.html_warning = Some(error);
        return Ok(Some(message)); // retain the older cached plain text; do not bless this version
    }
    store
        .put(
            &mail_store::message_key(account, folder, validity, message.uid),
            &message,
        )
        .map_err(|e| e.to_string())?;
    Ok(Some(message))
}

pub fn cache_message(
    store: &Store,
    account: &str,
    folder: &str,
    validity: u32,
    message: &mail::Mail,
    raw: &[u8],
) -> Result<()> {
    store
        .batch(&[
            (
                mail_store::message_key(account, folder, validity, message.uid),
                Some(serde_json::to_vec(message).unwrap()),
            ),
            (
                cache_key(account, folder, validity, message.uid),
                Some(serde_json::to_vec(&STANDARD.encode(raw)).unwrap()),
            ),
        ])
        .map_err(|e| format!("Nachricht konnte nicht gespeichert werden: {e}"))
}

// The path comes exclusively from a native Save dialog. Write completely before
// replacing the chosen destination; never follow an existing destination symlink.
pub fn save_to(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Ungültiger Speicherort.")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Anhang konnte am gewählten Ort nicht gespeichert werden.")?;
    temp.write_all(data)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "Anhang konnte nicht vollständig gespeichert werden.")?;
    temp.persist(path)
        .map_err(|_| "Anhang konnte am gewählten Ort nicht gespeichert werden.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hostile_names_cannot_choose_paths_or_windows_devices() {
        assert_eq!(safe_name("../../report.pdf"), "report.pdf");
        assert_eq!(safe_name("C:\\secret\\CON.txt"), "_CON.txt");
        assert_eq!(safe_name("..."), "attachment");
        assert_eq!(safe_name("invoice\u{202e}fdp.exe\r\n"), "invoicefdp.exe");
        assert_eq!(safe_name("NUL"), "_NUL");
    }
    #[test]
    fn import_survives_original_file_removal_and_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("mail.redb");
        let path = dir.path().join("Grüße.bin");
        std::fs::write(&path, [0, 255, 42, 0]).unwrap();
        let draft;
        {
            let store = Store::open(&db).unwrap();
            draft = import(&store, "a", crate::outbox::tests::draft(), &[path.clone()]).unwrap();
        }
        std::fs::remove_file(path).unwrap();
        let store = Store::open(&db).unwrap();
        let saved = outbox::drafts(&store, "a").unwrap().pop().unwrap();
        assert_eq!(saved.attachments[0].id, draft.attachments[0].id);
        assert_eq!(
            load(&store, "a", &saved.attachments).unwrap()[0].data,
            [0, 255, 42, 0]
        );
        assert!(load(&store, "other account", &saved.attachments).is_err());
    }
    #[test]
    fn a_failed_batch_does_not_add_partial_files_or_change_the_draft() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mail.redb")).unwrap();
        let draft = crate::outbox::tests::draft();
        outbox::save_draft(&store, "a", &draft).unwrap();
        let path = dir.path().join("ok.txt");
        std::fs::write(&path, "good").unwrap();
        assert!(import(&store, "a", draft, &[path, dir.path().join("missing")]).is_err());
        assert!(outbox::drafts(&store, "a").unwrap()[0]
            .attachments
            .is_empty());
        assert!(store
            .scan::<serde_json::Value>(&prefix("a"))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn writes_replace_only_the_selected_file() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("chosen.bin");
        std::fs::write(&target, "old").unwrap();
        save_to(&target, &[0, 255, 1]).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), [0, 255, 1]);
    }
    #[test]
    fn limits_and_stale_import_leave_committed_draft_intact() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mail.redb")).unwrap();
        let mut draft = outbox::tests::draft();
        outbox::save_draft(&store, "a", &draft).unwrap();
        let mut conflict = draft.clone();
        conflict.body = "same revision with different content".into();
        assert!(outbox::save_draft(&store, "a", &conflict).is_err());
        assert!(add_files(&store, "a", conflict, vec![]).is_err());
        let old = draft.clone();
        draft.revision += 1;
        outbox::save_draft(&store, "a", &draft).unwrap();
        assert!(add_files(&store, "a", old, vec![]).is_err());
        let large = dir.path().join("large");
        std::fs::File::create(&large)
            .unwrap()
            .set_len(MAX_BYTES as u64 + 1)
            .unwrap();
        assert!(import(&store, "a", draft.clone(), &[large]).is_err());
        let too_many = (0..=MAX_FILES)
            .map(|_| Content {
                name: "empty".into(),
                data: vec![],
            })
            .collect();
        assert!(add_files(&store, "a", draft.clone(), too_many).is_err());
        assert!(import(&store, "a", draft.clone(), &[dir.path().to_path_buf()]).is_err());
        assert_eq!(
            outbox::drafts(&store, "a").unwrap()[0].revision,
            draft.revision
        );
        assert!(store
            .scan::<serde_json::Value>(&prefix("a"))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn cached_attachments_are_bound_to_account_folder_and_uidvalidity() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("mail.redb");
        let raw = mail::build_message(
            &mail::tests::account(),
            &outbox::tests::draft(),
            &[Content {
                name: "report.bin".into(),
                data: vec![0, 255, 10],
            }],
        )
        .unwrap()
        .formatted();
        let message: mail::Mail = serde_json::from_value(serde_json::json!({ "uid": 42, "from": "a@example.org", "replyTo": "", "to": "b@example.org", "subject": "report", "date": "", "unread": false, "flagged": false, "size": raw.len(), "attachments": ["report.bin"] })).unwrap();
        {
            let store = Store::open(&db).unwrap();
            cache_message(&store, "a", "INBOX", 7, &message, &raw).unwrap();
        }
        let store = Store::open(&db).unwrap();
        for (account, folder, validity, uid) in [
            ("b", "INBOX", 7, 42),
            ("a", "Sent", 7, 42),
            ("a", "INBOX", 8, 42),
            ("a", "INBOX", 7, 43),
        ] {
            assert!(cached_raw(&store, account, folder, validity, uid)
                .unwrap()
                .is_none());
        }
        let cached = cached_raw(&store, "a", "INBOX", 7, 42).unwrap().unwrap();
        assert_eq!(cached, raw);
        let files = mail::decode_parts(&cached).unwrap().1;
        let forwarded = add_files(&store, "a", outbox::tests::draft(), files).unwrap();
        assert_eq!(
            load(&store, "a", &forwarded.attachments).unwrap()[0].data,
            [0, 255, 10]
        );
    }
    #[test]
    fn old_drafts_default_to_no_attachments() {
        let mut value = serde_json::to_value(outbox::tests::draft()).unwrap();
        value.as_object_mut().unwrap().remove("attachments");
        assert!(serde_json::from_value::<Draft>(value)
            .unwrap()
            .attachments
            .is_empty());
        assert!(safe_name(&"ä".repeat(200)).len() <= 180);
    }
    #[test]
    fn removing_files_or_drafts_reclaims_only_unshared_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("mail.redb")).unwrap();
        let mut first = add_files(
            &store,
            "a",
            outbox::tests::draft(),
            vec![Content {
                name: "keep.bin".into(),
                data: vec![42],
            }],
        )
        .unwrap();
        let refs = first.attachments.clone();
        let mut second = first.clone();
        second.id = mail::new_id();
        outbox::save_draft(&store, "a", &second).unwrap();
        first.attachments.clear();
        first.revision += 1;
        outbox::save_draft(&store, "a", &first).unwrap();
        assert_eq!(load(&store, "a", &refs).unwrap()[0].data, [42]);
        outbox::delete_draft(&store, "a", &second.id).unwrap();
        assert!(load(&store, "a", &refs).is_err());
        assert!(store
            .scan::<serde_json::Value>(&prefix("a"))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn upgrades_old_html_cache_offline_and_preserves_flags_and_uid_isolation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.redb");
        let raw = b"Content-Type: text/html; charset=utf-8\r\n\r\n<h2>Cached HTML</h2><img src='https://tracker.invalid/x'><p>Readable offline</p>";
        let old: mail::Mail = serde_json::from_value(serde_json::json!({"uid":42,"from":"a@example.org","replyTo":"","to":"b@example.org","subject":"Cached","date":"","unread":false,"flagged":true,"size":raw.len(),"body":"old placeholder","attachments":[]})).unwrap();
        {
            let store = Store::open(&path).unwrap();
            cache_message(&store, "a", "INBOX", 7, &old, raw).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert!(upgrade_cached(&store, "a", "INBOX", 8, old.clone())
            .unwrap()
            .is_none());
        let new = upgrade_cached(&store, "a", "INBOX", 7, old)
            .unwrap()
            .unwrap();
        assert!(!new.unread);
        assert!(new.flagged);
        assert_eq!(new.body_version, mail::BODY_VERSION);
        assert!(new.html.as_ref().unwrap().contains("<h2>Cached HTML</h2>"));
        assert!(!new.html.unwrap().contains("tracker.invalid"));
        assert!(new.body.unwrap().contains("Readable offline"));
        let saved: mail::Mail = store
            .get(&mail_store::message_key("a", "INBOX", 7, 42))
            .unwrap()
            .unwrap();
        assert_eq!(saved.body_version, mail::BODY_VERSION);
        assert_eq!(
            cached_raw(&store, "a", "INBOX", 7, 42).unwrap().unwrap(),
            raw
        );
        let mut legacy = saved;
        legacy.body_version = 0;
        legacy.body = Some("Old cached text".into());
        cache_message(
            &store,
            "a",
            "INBOX",
            7,
            &legacy,
            b"Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\na",
        )
        .unwrap();
        let recovered = upgrade_cached(&store, "a", "INBOX", 7, legacy)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.body.as_deref(), Some("Old cached text"));
        assert_eq!(recovered.body_version, 0);
        assert!(recovered.html_warning.is_some());
    }
}
