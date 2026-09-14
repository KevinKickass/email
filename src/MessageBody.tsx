import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, ShieldAlert } from "lucide-react";
import type { Mail } from "./model";
import { useI18n } from "./i18n";
import { htmlDocument } from "./htmlDocument";

export default function MessageBody({
  message,
  demo,
}: {
  message: Mail;
  demo: boolean;
}) {
  const { t } = useI18n();
  const [plain, setPlain] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const html = message.bodyVersion === 1 ? message.html : undefined;
  const document = useMemo(() => (html ? htmlDocument(html) : ""), [html]);
  async function open(url: string) {
    if (demo || opening) return;
    setOpening(true);
    setError("");
    try {
      await invoke("open_web_link", { url });
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(false);
    }
  }
  return (
    <>
      {html && (
        <div
          className="body-toolbar"
          role="group"
          aria-label={t("Nachrichtendarstellung")}
        >
          <button aria-pressed={!plain} onClick={() => setPlain(false)}>
            {t("HTML")}
          </button>
          <button aria-pressed={plain} onClick={() => setPlain(true)}>
            {t("Nur-Text")}
          </button>
        </div>
      )}
      {message.htmlWarning && (
        <p className="html-notice" role="status">
          {t(message.htmlWarning)}
        </p>
      )}
      {html && !plain ? (
        <div className="html-reader">
          <iframe
            title={t("Formatierter Nachrichteninhalt")}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={document}
          />
        </div>
      ) : (
        <div className="message-body">
          {message.body || t("Kein darstellbarer Nachrichtentext.")}
        </div>
      )}
      {!!message.links?.length && (
        <details className="message-links">
          <summary>
            {t("Weblinks ({count})", { count: message.links.length })}
          </summary>
          <p>{t("Die Zieladresse wird im Standardbrowser geöffnet.")}</p>
          <ul>
            {message.links.map((url) => (
              <li key={url}>
                <button
                  disabled={demo || opening}
                  onClick={() => void open(url)}
                  title={
                    demo
                      ? t("Links sind in der Demo deaktiviert.")
                      : t("Im Browser öffnen")
                  }
                >
                  <ExternalLink size={14} />
                  <bdi dir="ltr">{url}</bdi>
                </button>
              </li>
            ))}
          </ul>
          {error && (
            <p className="form-error" role="alert">
              {t(error)}
            </p>
          )}
        </details>
      )}
      <div className="reading-footer">
        <ShieldAlert size={13} />
        {t(
          "Bilder, Skripte und Formulare werden nicht geladen. Weblinks stehen unter der Nachricht.",
        )}
      </div>
    </>
  );
}
