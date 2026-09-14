import { isTauri } from "@tauri-apps/api/core";
import { Settings, X } from "lucide-react";
import { usePreferences, type Language } from "./preferences";
import { useI18n } from "./i18n";
import type { useUpdates } from "./updates";
import { version } from "../package.json";

export default function SettingsDialog({
  onClose,
  updates,
  hasOpenWork,
}: {
  onClose: () => void;
  updates: ReturnType<typeof useUpdates>;
  hasOpenWork: boolean;
}) {
  const { settings, ready, saving, error, save } = usePreferences();
  const { t } = useI18n();
  const statusText = {
    idle: "Noch nicht nach Updates gesucht.",
    checking: "Updates werden gesucht …",
    current: "email ist auf dem neuesten Stand.",
    available: "Ein Update ist verfügbar.",
    downloading: "Update wird heruntergeladen …",
    ready: "Update ist bereit zur Installation.",
    installing: "Update wird installiert …",
    restart: "Update installiert. Bitte email neu starten.",
    error: "Update fehlgeschlagen. Bitte erneut versuchen.",
  };
  return (
    <div className="modal-backdrop">
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="dialog-title">
          <span id="settings-title">
            <Settings size={16} />
            {t("Einstellungen")}
          </span>
          <button
            autoFocus
            aria-label={t("Einstellungen schließen")}
            disabled={updates.status === "installing"}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="settings-content">
          <h2>{t("Sprache")}</h2>
          <label className="language-field">
            {t("Sprache der Oberfläche")}
            <select
              value={settings.language}
              disabled={!ready || saving}
              onChange={(e) =>
                void save({ ...settings, language: e.target.value as Language })
              }
            >
              <option value="system">{t("Automatisch (Systemsprache)")}</option>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </select>
          </label>
          <h2>{t("Updates")}</h2>
          <p>email {version} · Apache-2.0</p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.autoUpdate}
              disabled={!ready || saving || !isTauri()}
              onChange={(e) =>
                void save({ ...settings, autoUpdate: e.target.checked })
              }
            />
            <span>{t("Updates automatisch suchen und herunterladen")}</span>
          </label>
          <p>
            {t(
              "Prüft nach dem Start und alle sechs Stunden GitHub Releases. Zur Installation wählen Sie selbst den Neustart. Standardmäßig ausgeschaltet.",
            )}
          </p>
          {!isTauri() && (
            <p>
              {t(
                "Updates sind in der Desktop-App verfügbar. Die Sprachauswahl ist hier eine Vorschau.",
              )}
            </p>
          )}
          <div role="status" className="update-status">
            {t(statusText[updates.status])}
            {updates.version && ` (${updates.version})`}
          </div>
          {updates.status === "downloading" && (
            <progress
              aria-label={t("Downloadfortschritt")}
              max={100}
              value={updates.progress ?? undefined}
            />
          )}
          {updates.notes && (
            <details>
              <summary>{t("Versionshinweise")}</summary>
              <pre className="release-notes">{updates.notes}</pre>
            </details>
          )}
          {hasOpenWork && (
            <p>
              {t(
                "Schließen Sie offene Nachrichten und warten Sie laufende Vorgänge ab, bevor Sie das Update installieren.",
              )}
            </p>
          )}
          {(error || updates.error) && (
            <p className="form-error" role="alert">
              {error || updates.error}
            </p>
          )}
          <div className="update-actions">
            {["idle", "current", "error"].includes(updates.status) && (
              <button
                className="standard-button"
                disabled={!isTauri() || !ready}
                onClick={() => void updates.checkNow()}
              >
                {t("Jetzt nach Updates suchen")}
              </button>
            )}
            {updates.status === "available" && (
              <button
                className="primary-button"
                onClick={() => void updates.downloadNow()}
              >
                {t("Update herunterladen")}
              </button>
            )}
            {updates.status === "ready" && (
              <button
                className="primary-button"
                disabled={hasOpenWork}
                onClick={() => void updates.installNow()}
              >
                {t("Installieren und neu starten")}
              </button>
            )}
            {updates.status === "restart" && (
              <button
                className="primary-button"
                disabled={hasOpenWork}
                onClick={() => void updates.restartNow()}
              >
                {t("Jetzt neu starten")}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
