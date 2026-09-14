import { usePreferences, type Language } from "./preferences";
import en from "./locales/en.json";

export function resolveLanguage(
  language: Language,
  system = navigator.language,
): "de" | "en" {
  return language === "system"
    ? system.toLowerCase().startsWith("de")
      ? "de"
      : "en"
    : language;
}
export function translate(
  key: string,
  language: "de" | "en",
  values: Record<string, string | number> = {},
) {
  let text =
    language === "en" && Object.hasOwn(en, key)
      ? (en as Record<string, string>)[key]
      : key;
  if (language === "en" && text === key) {
    for (const [source, translated] of Object.entries(en)) {
      if (source.endsWith("{detail}") && key.startsWith(source.slice(0, -8))) {
        text = translated.replace("{detail}", () =>
          key.slice(source.length - 8),
        );
        break;
      }
    }
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    String(values[name] ?? match),
  );
}
export function useI18n() {
  const { settings } = usePreferences();
  const language = resolveLanguage(settings.language);
  return {
    language,
    locale: language === "de" ? "de-DE" : "en-GB",
    t: (key: string, values?: Record<string, string | number>) =>
      translate(key, language, values),
  };
}
