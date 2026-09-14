use crate::{blocking, Backend, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub auto_update: bool,
    pub language: Language,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    De,
    En,
}

#[tauri::command]
pub async fn load_settings(state: tauri::State<'_, Arc<Backend>>) -> Result<Settings> {
    let state = Arc::clone(&state);
    blocking(move || {
        state
            .store
            .get("settings-v1")
            .map(Option::unwrap_or_default)
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn save_settings(
    state: tauri::State<'_, Arc<Backend>>,
    settings: Settings,
) -> Result<()> {
    let state = Arc::clone(&state);
    blocking(move || {
        state
            .store
            .put("settings-v1", &settings)
            .map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_preferences_never_enable_background_updates() {
        assert!(!Settings::default().auto_update);
        let migrated: Settings = serde_json::from_str(r#"{"language":"en"}"#).unwrap();
        assert!(!migrated.auto_update);
        assert!(matches!(migrated.language, Language::En));
        assert!(serde_json::from_str::<Settings>(r#"{"language":"invalid"}"#).is_err());
    }
}
