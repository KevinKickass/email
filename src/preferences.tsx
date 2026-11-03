import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type Language = "system" | "de" | "en";
export type Theme = "system" | "light" | "dark";
export type Preferences = {
  autoUpdate: boolean;
  language: Language;
  theme: Theme;
};
export const defaults: Preferences = {
  autoUpdate: false,
  language: "system",
  theme: "system",
};
const themeKey = "email-theme";
function cachedTheme(): Theme {
  try {
    const value = localStorage.getItem(themeKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
const Context = createContext<{
  settings: Preferences;
  resolvedTheme: "light" | "dark";
  ready: boolean;
  saving: boolean;
  error: string;
  save: (next: Preferences) => Promise<void>;
}>(null!);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(() => ({
    ...defaults,
    theme: cachedTheme(),
  }));
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const resolvedTheme =
    settings.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : settings.theme;
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const changed = () => setSystemDark(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    let active = true;
    const task = isTauri()
      ? invoke<Preferences>("load_settings")
      : Promise.resolve({ ...defaults, theme: cachedTheme() });
    task
      .then((value) => {
        if (active) {
          setSettings({ ...defaults, ...value });
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
      try {
        localStorage.setItem(themeKey, next.theme);
      } catch {
        // Desktop persistence remains available when browser storage is blocked.
      }
      setSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Context.Provider
      value={{ settings, resolvedTheme, ready, saving, error, save }}
    >
      {children}
    </Context.Provider>
  );
}
export const usePreferences = () => useContext(Context);
