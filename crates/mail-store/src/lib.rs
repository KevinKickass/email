//! Durable local metadata and bounded message snapshots. No credentials in this store.
use redb::{Database, ReadableDatabase, TableDefinition};
use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

const RECORDS: TableDefinition<&str, &[u8]> = TableDefinition::new("records_v1");
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub struct Store(Database);

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Database::builder()
            .set_cache_size(16 * 1024 * 1024)
            .create(path)?;
        let tx = db.begin_write()?;
        {
            tx.open_table(RECORDS)?;
        }
        tx.commit()?;
        Ok(Self(db))
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let tx = self.0.begin_read()?;
        let table = tx.open_table(RECORDS)?;
        let value = table.get(key)?;
        value
            .map(|v| serde_json::from_slice(v.value()).map_err(Into::into))
            .transpose()
    }

    pub fn put<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        let tx = self.0.begin_write()?;
        {
            tx.open_table(RECORDS)?.insert(key, bytes.as_slice())?;
        }
        // redb defaults to Immediate durability: commit is durable before returning.
        tx.commit()?;
        Ok(())
    }

    pub fn batch(&self, changes: &[(String, Option<Vec<u8>>)]) -> Result<()> {
        let tx = self.0.begin_write()?;
        {
            let mut table = tx.open_table(RECORDS)?;
            for (key, value) in changes {
                match value {
                    Some(bytes) => {
                        table.insert(key.as_str(), bytes.as_slice())?;
                    }
                    None => {
                        table.remove(key.as_str())?;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn scan<T: DeserializeOwned>(&self, prefix: &str) -> Result<Vec<T>> {
        let tx = self.0.begin_read()?;
        let table = tx.open_table(RECORDS)?;
        let mut values = Vec::new();
        for entry in table.range(prefix..)? {
            let (key, value) = entry?;
            if !key.value().starts_with(prefix) {
                break;
            }
            values.push(serde_json::from_slice(value.value())?);
        }
        Ok(values)
    }
}

/// Account identity + folder + UIDVALIDITY prevent reusing bodies after UID resets.
pub fn message_key(account: &str, folder: &str, validity: u32, uid: u32) -> String {
    serde_json::to_string(&("message-v1", account, folder, validity, uid))
        .expect("strings serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_data_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.redb");
        {
            let store = Store::open(&path).unwrap();
            store
                .put("account", &vec!["imap.example.org", "user@example.org"])
                .unwrap();
            store.put("draft", &"Entwurf mit Umlauten: Grüße").unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.get::<String>("draft").unwrap().unwrap(),
            "Entwurf mit Umlauten: Grüße"
        );
        assert_eq!(
            store.get::<Vec<String>>("account").unwrap().unwrap().len(),
            2
        );
        assert!(store.get::<String>("missing").unwrap().is_none());
    }

    #[test]
    fn identity_and_uidvalidity_isolate_messages() {
        let key = message_key("a", "INBOX", 1, 5);
        assert_ne!(key, message_key("a", "INBOX", 2, 5));
        assert_ne!(key, message_key("b", "INBOX", 1, 5));
        assert_ne!(message_key("a/b", "c", 1, 5), message_key("a", "b/c", 1, 5));
    }

    #[test]
    fn uncommitted_transaction_is_rolled_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mail.redb");
        {
            let store = Store::open(&path).unwrap();
            store.put("draft", &"saved").unwrap();
            let tx = store.0.begin_write().unwrap();
            tx.open_table(RECORDS)
                .unwrap()
                .insert("draft", b"\"unsaved\"".as_slice())
                .unwrap();
        }
        assert_eq!(
            Store::open(&path)
                .unwrap()
                .get::<String>("draft")
                .unwrap()
                .unwrap(),
            "saved"
        );
    }
}
