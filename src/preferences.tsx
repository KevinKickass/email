import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type Language = "system" | "de" | "en";
export type Preferences = { autoUpdate: boolean; language: Language };
export const defaults: Preferences = { autoUpdate: false, language: "system" };
const Context = createContext<{
  settings: Preferences;
  ready: boolean;
  saving: boolean;
  error: string;
  save: (next: Preferences) => Promise<void>;
}>(null!);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(defaults);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const task = isTauri()
      ? invoke<Preferences>("load_settings")
      : Promise.resolve(defaults);
    task
      .then((value) => {
        if (active) {
          setSettings(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  async function save(next: Preferences) {
    if (!ready || saving) return;
    setSaving(true);
    setError("");
    try {
      if (isTauri()) await invoke("save_settings", { settings: next });
      setSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Context.Provider value={{ settings, ready, saving, error, save }}>
      {children}
    </Context.Provider>
  );
}
export const usePreferences = () => useContext(Context);
