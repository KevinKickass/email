import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, FilePenLine, Send } from "lucide-react";
import {
  accountIdentity,
  type Account,
  type Draft,
  type Submission,
} from "./model";
import { useI18n } from "./i18n";

export default function LocalWorkDialog({
  account,
  onClose,
  onOpen,
  onBusy,
}: {
  account: Account;
  onClose: () => void;
  onOpen: (draft: Draft) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [history, setHistory] = useState<Submission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const accountId = accountIdentity(account);
  async function reload() {
    const [drafts, history] = await invoke<[Draft[], Submission[]]>(
      "local_work",
      { accountId },
    );
    setDrafts(drafts);
    setHistory(history);
  }
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, [accountId]);
  async function retry(entry: Submission) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await invoke("send_message", {
        accountId,
        draft: entry.draft,
        sentFolder: entry.sentFolder,
      });
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  async function remove(draft: Draft) {
    if (!window.confirm(t("Diesen lokalen Entwurf endgültig löschen?"))) return;
    setBusy(true);
    try {
      await invoke("delete_draft", { accountId, id: draft.id });
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function status(entry: Submission) {
    switch (entry.status) {
      case "complete":
        return t("Gesendet und im IMAP-Ordner gespeichert");
      case "copy_pending":
        return t("Gesendet · IMAP-Kopie ausstehend");
      case "rejected":
        return t("Vom SMTP-Server abgelehnt");
      default:
        return t(
          "Versandstatus unklar · Nicht erneut senden, ohne den Empfang zu prüfen",
        );
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="work-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-title"
      >
        <div className="dialog-title">
          <span id="work-title">{t("Lokale Entwürfe & Versand")}</span>
          <button
            autoFocus
            disabled={busy}
            aria-label={t("Schließen")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="work-content">
          {error && (
            <p className="form-error" role="alert">
              {t(error)}
            </p>
          )}
          <h2>
            <FilePenLine size={18} />
            {t("Lokale Entwürfe")}
          </h2>
          {!drafts.length && <p>{t("Keine lokalen Entwürfe vorhanden.")}</p>}
          {drafts.map((draft) => (
            <article className="work-entry" key={draft.id}>
              <strong>{draft.subject || t("(Kein Betreff)")}</strong>
              <span>{draft.to || t("Noch kein Empfänger")}</span>
              <div className="work-actions">
                <button
                  className="standard-button"
                  disabled={busy}
                  onClick={() => onOpen(draft)}
                >
                  {t("Weiter bearbeiten")}
                </button>
                <button
                  className="standard-button"
                  disabled={busy}
                  onClick={() => void remove(draft)}
                >
                  {t("Löschen")}
                </button>
              </div>
            </article>
          ))}
          <h2>
            <Send size={18} />
            {t("Versandverlauf")}
          </h2>
          {!history.length && <p>{t("Noch keine Nachrichten versendet.")}</p>}
          {history.map((entry) => (
            <article
              className={`work-entry ${entry.status === "complete" ? "" : "pending"}`}
              key={entry.draft.id}
            >
              <strong>{entry.draft.subject}</strong>
              <span>{entry.draft.to}</span>
              <b>{status(entry)}</b>
              {entry.detail && <p>{t(entry.detail)}</p>}
              <details>
                <summary>{t("Nachricht anzeigen")}</summary>
                <pre>{entry.draft.body}</pre>
                {!!entry.draft.attachments?.length && (
                  <ul aria-label={t("Anhänge")}>
                    {entry.draft.attachments.map((file) => (
                      <li key={file.id}>{file.name}</li>
                    ))}
                  </ul>
                )}
              </details>
              {entry.status === "copy_pending" && (
                <button
                  className="standard-button"
                  disabled={busy}
                  onClick={() => void retry(entry)}
                >
                  {t("Gesendet-Kopie erneut prüfen")}
                </button>
              )}
              {(entry.status === "uncertain" || entry.status === "sending") && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={!!checked[entry.draft.id]}
                    onChange={(e) =>
                      setChecked((old) => ({
                        ...old,
                        [entry.draft.id]: e.target.checked,
                      }))
                    }
                  />
                  {t(
                    "Ich habe geprüft, dass die Nachricht nicht angekommen ist.",
                  )}
                </label>
              )}
              {(entry.status === "rejected" || checked[entry.draft.id]) && (
                <button
                  className="standard-button"
                  disabled={busy}
                  onClick={() =>
                    onOpen({
                      ...entry.draft,
                      id: crypto.randomUUID(),
                      revision: 0,
                    })
                  }
                >
                  {t("Als neuen Entwurf öffnen")}
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
