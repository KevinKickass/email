import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, ImageOff, ShieldAlert } from "lucide-react";
import type { Mail } from "./model";
import { useI18n } from "./i18n";
import { htmlDocument } from "./htmlDocument";
import { usePreferences } from "./preferences";
import {
  bindMailFrame,
  displayMailImages,
  type LoadedImage,
} from "./mailFrame";

type MessageLocation = {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: number;
};
export default function MessageBody({
  message,
  demo,
  location,
}: {
  message: Mail;
  demo: boolean;
  location?: MessageLocation;
}) {
  const { t } = useI18n();
  const { resolvedTheme } = usePreferences();
  const [plain, setPlain] = useState(false);
  const [opening, setOpening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [images, setImages] = useState<LoadedImage[]>([]);
  const [failed, setFailed] = useState(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const unbind = useRef<(() => void) | undefined>(undefined);
  const request = useRef(0);
  const loadingRef = useRef(false);
  const openingRef = useRef(false);
  const html = message.bodyVersion === 2 ? message.html : undefined;
  const document = useMemo(
    () => (html ? htmlDocument(html, resolvedTheme) : ""),
    [html, resolvedTheme],
  );
  const remoteImages = message.remoteImages ?? [];
  const remaining = remoteImages
    .map((_, index) => index)
    .filter((index) => !images.some((image) => image.index === index));

  useEffect(() => {
    ++request.current;
    setImages([]);
    setFailed(0);
    setLoading(false);
    setError("");
    setPreview("");
    setPlain(false);
    loadingRef.current = false;
    return () => {
      ++request.current;
      unbind.current?.();
    };
  }, [
    message.uid,
    message.html,
    location?.accountId,
    location?.folder,
    location?.uidValidity,
  ]);

  async function open(url: string) {
    if (demo || openingRef.current) return;
    const id = request.current;
    openingRef.current = true;
    setOpening(true);
    setError("");
    try {
      await invoke("open_web_link", { url });
    } catch (e) {
      if (id === request.current) setError(String(e));
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }
  function prepareFrame() {
    unbind.current?.();
    const content = frame.current?.contentDocument;
    if (!content) return;
    unbind.current = bindMailFrame(
      content,
      message.links ?? [],
      demo,
      (url) => void open(url),
      setPreview,
    );
    displayMailImages(content, images);
  }
  useEffect(() => {
    const content = frame.current?.contentDocument;
    if (content) displayMailImages(content, images);
  }, [images]);

  async function loadImages() {
    if (demo || !location || loadingRef.current || !remaining.length) return;
    const id = request.current;
    loadingRef.current = true;
    setLoading(true);
    setError("");
    setFailed(0);
    try {
      const result = await invoke<{ images: LoadedImage[]; failed: number }>(
        "load_message_images",
        { location, indices: remaining },
      );
      if (id !== request.current) return;
      setImages((old) => [
        ...old,
        ...result.images.filter((image) => remaining.includes(image.index)),
      ]);
      setFailed(result.failed);
    } catch (e) {
      if (id === request.current) setError(String(e));
    } finally {
      if (id === request.current) {
        loadingRef.current = false;
        setLoading(false);
      }
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
          <button
            aria-pressed={plain}
            onClick={() => {
              setPlain(true);
              setPreview("");
            }}
          >
            {t("Nur-Text")}
          </button>
        </div>
      )}
      {message.htmlWarning && (
        <p className="html-notice" role="status">
          {t(message.htmlWarning)}
        </p>
      )}
      {html && !plain && remoteImages.length > 0 && (
        <div
          className="remote-content-banner"
          role="region"
          aria-label={t("Externe Inhalte")}
        >
          <ImageOff size={18} />
          <div>
            <p role="status">
              {loading
                ? t("Externe Bilder werden geladen …")
                : remaining.length
                  ? t(
                      remaining.length === 1
                        ? "Ein externes Bild wurde blockiert."
                        : "{count} externe Bilder wurden blockiert.",
                      {
                        count: remaining.length,
                      },
                    )
                  : t("Externe Bilder für diese Nachricht geladen.")}
            </p>
            {remaining.length > 0 && (
              <small>
                {t(
                  "Beim Laden kann der Absender erkennen, dass Sie die Nachricht geöffnet haben.",
                )}
              </small>
            )}
            {failed > 0 && (
              <small>
                {t(
                  failed === 1
                    ? "Ein Bild konnte nicht geladen werden."
                    : "{count} Bilder konnten nicht geladen werden.",
                  {
                    count: failed,
                  },
                )}
              </small>
            )}
          </div>
          {remaining.length > 0 && (
            <button
              className="standard-button"
              disabled={demo || !location || loading}
              onClick={() => void loadImages()}
            >
              {failed ? t("Erneut versuchen") : t("Bilder laden")}
            </button>
          )}
          {images.length > 0 && (
            <button
              className="standard-button"
              disabled={loading}
              onClick={() => {
                setImages([]);
                setFailed(0);
              }}
            >
              {t("Bilder wieder blockieren")}
            </button>
          )}
        </div>
      )}
      {html && !plain ? (
        <div className="html-reader">
          <iframe
            ref={frame}
            title={t("Formatierter Nachrichteninhalt")}
            sandbox="allow-same-origin"
            referrerPolicy="no-referrer"
            srcDoc={document}
            onLoad={prepareFrame}
          />
        </div>
      ) : (
        <div className="message-body">
          {message.body || t("Kein darstellbarer Nachrichtentext.")}
        </div>
      )}
      {preview && (
        <div className="link-preview" role="status">
          <ExternalLink size={12} />
          <bdi dir="ltr">{preview}</bdi>
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
        </details>
      )}
      {error && (
        <p className="form-error reader-error" role="alert">
          {t(error)}
        </p>
      )}
      <div className="reading-footer">
        <ShieldAlert size={13} />
        {t(
          "Externe Bilder werden nur auf Wunsch geladen. Skripte und Formulare bleiben deaktiviert.",
        )}
      </div>
    </>
  );
}
