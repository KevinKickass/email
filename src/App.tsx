import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createDraftWriter } from "./draftWriter";
import LocalWorkDialog from "./LocalWorkDialog";
import SettingsDialog from "./SettingsDialog";
import { useUpdates } from "./updates";
import { useI18n } from "./i18n";
import { version } from "../package.json";
import {
  Mail as MailIcon,
  Inbox,
  Send,
  FilePenLine,
  Archive,
  Trash2,
  ShieldAlert,
  Folder as FolderIcon,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Search,
  Reply,
  Forward,
  RefreshCw,
  Flag,
  Paperclip,
  CalendarDays,
  Settings,
  X,
  Check,
  PanelRight,
  ListFilter,
  MailOpen,
  Plus,
  Monitor,
  CircleHelp,
  Save,
  LockKeyhole,
  Clock3,
} from "lucide-react";
import {
  type Account,
  type Folder,
  type Mail,
  type Draft,
  type Submission,
  accountIdentity,
  emptyAccount,
  demoFolders,
  demoMail,
  senderName,
  emailAddress,
  shortDate,
} from "./model";

const desktop = isTauri();
const icons = [Inbox, FilePenLine, Send, Archive, ShieldAlert, Trash2];
const blankDraft = (): Draft => ({
  id: crypto.randomUUID(),
  revision: 0,
  to: "",
  subject: "",
  body: "",
});
type Snapshot = {
  messages: Mail[];
  uidValidity: number;
  offline: boolean;
  warning?: string | null;
};
function Tool({
  icon,
  children,
  onClick,
  disabled = false,
  large = false,
  title,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  large?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`tool ${large ? "large" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

export default function App() {
  const { t, locale, language } = useI18n();
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [demo, setDemo] = useState(true);
  const [folders, setFolders] = useState(demoFolders);
  const [folder, setFolder] = useState("INBOX");
  const [messages, setMessages] = useState<Mail[]>(demoMail);
  const [demoArchive, setDemoArchive] = useState<Record<string, Mail[]>>({});
  const [selected, setSelected] = useState<number | null>(8);
  const [message, setMessage] = useState<Mail | null>(demoMail[0]);
  const [uidValidity, setUidValidity] = useState(0);
  const [offline, setOffline] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "unread" | "flagged">("all");
  const [tab, setTab] = useState("Start");
  const [view, setView] = useState<"mail" | "calendar">("mail");
  const [reading, setReading] = useState(true);
  const [dense, setDense] = useState(false);
  const [setup, setSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bodyBusy, setBodyBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [sentFolder, setSentFolder] = useState("");
  const [moveTarget, setMoveTarget] = useState("");
  const saveQueue = useRef(
    createDraftWriter((accountId, draft) =>
      invoke("save_draft", { accountId, draft }),
    ),
  );
  const live = useRef({ draft, account, sendBusy, demo });
  live.current = { draft, account, sendBusy, demo };
  const requestId = useRef(0);
  const bodyId = useRef(0);
  const active = useRef({ demo, folder, uidValidity });
  active.current = { demo, folder, uidValidity };

  const hasOpenWork =
    setup || workOpen || draft !== null || sendBusy || busy || bodyBusy;
  const updates = useUpdates(hasOpenWork);
  const modalOpen = setup || workOpen || draft !== null || preferencesOpen;
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    if (!modalOpen) return;
    const background = [
      ...document.querySelectorAll<HTMLElement>(".app > :not(.modal-backdrop)"),
    ];
    background.forEach((element) => {
      element.inert = true;
    });
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const fields = [
        ...document.querySelectorAll<HTMLElement>(
          ".modal-backdrop button:not(:disabled), .modal-backdrop input:not(:disabled), .modal-backdrop select:not(:disabled), .modal-backdrop textarea:not(:disabled), .modal-backdrop summary",
        ),
      ];
      const first = fields[0];
      const last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", trapFocus);
    return () => {
      background.forEach((element) => {
        element.inert = false;
      });
      document.removeEventListener("keydown", trapFocus);
    };
  }, [modalOpen]);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    invoke<{
      account: Account;
      folders: Folder[];
      snapshot: Snapshot | null;
    } | null>("load_startup")
      .then(async (saved) => {
        if (!saved || cancelled) return;
        setAccount(saved.account);
        setDemo(false);
        setFolders(saved.folders);
        setMessages(saved.snapshot?.messages ?? []);
        setUidValidity(saved.snapshot?.uidValidity ?? 0);
        setSelected(null);
        setMessage(null);
        setOffline(true);
        if (saved.account.rememberPassword) {
          void invoke<Folder[]>("list_folders")
            .then((fs) => {
              if (
                !cancelled &&
                live.current.account &&
                accountIdentity(live.current.account) ===
                  accountIdentity(saved.account)
              )
                setFolders(fs);
            })
            .catch(() => {
              /* Cached folder tree remains available. Refresh/reconnect reports errors. */
            });
          const id = ++requestId.current;
          // Cache is visible before network/keyring access. Never replace another selected folder.
          const result = await invoke<Snapshot>("list_messages", {
            folder: "INBOX",
          });
          if (cancelled || id !== requestId.current) return;
          // The cached selection belongs to the old snapshot. Invalidate in-flight
          // body reads before accepting a potentially different UIDVALIDITY.
          ++bodyId.current;
          setSelected(null);
          setMessage(null);
          setBodyBusy(false);
          setMessages(result.messages);
          setUidValidity(result.uidValidity);
          setOffline(result.offline);
          if (result.warning) setError(result.warning);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!draft || demo || !account || sendBusy) return;
    const snapshot = draft;
    const timer = setTimeout(() => {
      void saveQueue
        .current(accountIdentity(account), snapshot)
        .then(() => {
          if (
            live.current.draft?.id === snapshot.id &&
            live.current.draft.revision === snapshot.revision
          )
            setDraftSaved(true);
        })
        .catch((e) => {
          if (live.current.draft?.id === snapshot.id) setError(String(e));
        });
    }, 500);
    return () => clearTimeout(timer);
  }, [draft, demo, account, sendBusy]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        const current = live.current;
        if (current.sendBusy) {
          event.preventDefault();
          return;
        }
        if (!current.draft || current.demo || !current.account) return;
        event.preventDefault();
        try {
          let snapshot = current.draft;
          while (true) {
            await saveQueue.current(accountIdentity(current.account), snapshot);
            if (live.current.sendBusy) return;
            const latest = live.current.draft;
            if (
              !latest ||
              (latest.id === snapshot.id &&
                latest.revision === snapshot.revision)
            )
              break;
            snapshot = latest;
          }
          await getCurrentWindow().destroy();
        } catch (e) {
          setError(String(e));
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 6000);
      return () => clearTimeout(t);
    }
  }, [notice]);

  async function refresh(target = folder) {
    if (demo) {
      setNotice(
        t("Demoansicht aktualisiert. Es besteht keine Serververbindung."),
      );
      return;
    }
    const id = ++requestId.current;
    ++bodyId.current;
    setBusy(true);
    setError("");
    setMessage(null);
    setSelected(null);
    setBodyBusy(false);
    try {
      const result = await invoke<Snapshot>("list_messages", {
        folder: target,
      });
      if (!result.offline) {
        try {
          const fs = await invoke<Folder[]>("list_folders");
          if (id === requestId.current) setFolders(fs);
        } catch {
          /* Keep the cached tree. */
        }
      }
      if (id !== requestId.current) return;
      setMessages(result.messages);
      setUidValidity(result.uidValidity);
      setOffline(result.offline);
      if (result.warning) setError(result.warning);
      setNotice(
        result.offline
          ? t(
              "Aktualisierung fehlgeschlagen. Gespeicherte Nachrichten werden angezeigt.",
            )
          : t("Nachrichten aktualisiert."),
      );
    } catch (e) {
      if (id === requestId.current) {
        setError(String(e));
        setMessages([]);
      }
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  function selectFolder(name: string) {
    if (name === folder) return;
    if (demo) setDemoArchive((old) => ({ ...old, [folder]: messages }));
    setFolder(name);
    setSelected(null);
    setMessage(null);
    setQuery("");
    setFilter("all");
    setView("mail");
    if (demo) setMessages(demoArchive[name] ?? []);
    else void refresh(name);
  }

  async function openMail(mail: Mail) {
    setSelected(mail.uid);
    setError("");
    if (demo) {
      setMessage(mail);
      setMessages((old) =>
        old.map((m) => (m.uid === mail.uid ? { ...m, unread: false } : m)),
      );
      return;
    }
    const id = ++bodyId.current;
    const target = folder;
    setMessage(null);
    setBodyBusy(true);
    try {
      const result = await invoke<Mail>("read_message", {
        folder: target,
        uid: mail.uid,
        uidValidity,
      });
      if (id === bodyId.current && active.current.folder === target)
        setMessage(result);
    } catch (e) {
      if (id === bodyId.current) setError(String(e));
    } finally {
      if (id === bodyId.current) setBodyBusy(false);
    }
  }

  async function setFlag(kind: "seen" | "flagged") {
    const mail = messages.find((m) => m.uid === selected);
    if (!mail) return;
    const value = kind === "seen" ? mail.unread : !mail.flagged;
    const scope = active.current;
    setBusy(true);
    try {
      if (!demo)
        await invoke("set_flag", {
          folder,
          uid: mail.uid,
          uidValidity,
          kind,
          value,
        });
      if (
        scope.folder !== active.current.folder ||
        scope.demo !== active.current.demo
      )
        return;
      setMessages((old) =>
        old.map((m) =>
          m.uid !== mail.uid
            ? m
            : {
                ...m,
                ...(kind === "seen" ? { unread: !value } : { flagged: value }),
              },
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function targetFor(role: string) {
    if (demo) return role[0].toUpperCase() + role.slice(1);
    const matching = folders.filter((f) => f.selectable && f.role === role);
    return matching.length === 1 ? matching[0].name : "";
  }

  async function moveMail(target: string) {
    if (selected === null || !target || target === folder || busy) return;
    const mail = messages.find((m) => m.uid === selected);
    if (!mail) return;
    const source = folder;
    setBusy(true);
    setError("");
    ++bodyId.current;
    setBodyBusy(false);
    try {
      if (demo)
        setDemoArchive((old) => ({
          ...old,
          [target]: [...(old[target] ?? []), mail],
        }));
      else
        await invoke("move_message", {
          folder: source,
          target,
          uid: mail.uid,
          uidValidity,
        });
      if (active.current.folder !== source) return;
      setMessages((old) => old.filter((m) => m.uid !== mail.uid));
      setSelected(null);
      setMessage(null);
      setNotice(t("Nachricht verschoben."));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function compose(mode: "new" | "reply" | "forward") {
    setDraftSaved(false);
    setError("");
    setSentFolder(targetFor("sent"));
    const next = blankDraft();
    if (mode !== "new" && message) {
      next.to =
        mode === "reply" ? emailAddress(message.replyTo || message.from) : "";
      next.subject = `${mode === "reply" ? "Re" : "Fwd"}: ${message.subject.replace(/^(Re|Fwd):\s*/i, "")}`;
      next.body = `\n\n──────── ${t("Ursprüngliche Nachricht")} ────────\n${t("Von:")} ${message.from}\n${t("Betreff")}: ${message.subject}\n\n${message.body ?? ""}`;
    }
    setDraft(next);
  }

  async function saveDraft(close = false) {
    if (!draft) return;
    const snapshot = draft;
    try {
      if (!demo && account)
        await saveQueue.current(accountIdentity(account), snapshot);
      if (
        live.current.draft?.id !== snapshot.id ||
        live.current.draft.revision !== snapshot.revision
      )
        return;
      setDraftSaved(true);
      if (close) setDraft(null);
      setNotice(
        demo
          ? t("Demoentwurf bleibt bis zum Schließen dieses Fensters erhalten.")
          : t("Entwurf lokal in redb gespeichert."),
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft || live.current.sendBusy) return;
    if (demo) {
      setNotice(t("Demo: Es wurde keine E-Mail versendet."));
      setDraft(null);
      return;
    }
    if (!account) return;
    live.current.sendBusy = true;
    setSendBusy(true);
    setError("");
    try {
      const accountId = accountIdentity(account);
      await saveQueue.current(accountId, draft);
      await invoke<Submission>("send_message", {
        accountId,
        draft,
        sentFolder,
      });
      setDraft(null);
      setWorkOpen(true);
    } catch (e) {
      setError(String(e));
      // A dropped IPC response can follow successful SMTP. Consult durable history before retrying.
      try {
        const [, history] = await invoke<[Draft[], Submission[]]>(
          "local_work",
          { accountId: accountIdentity(account) },
        );
        if (history.some((item) => item.draft.id === draft.id)) {
          setDraft(null);
          setWorkOpen(true);
        }
      } catch {
        /* Keep the saved draft visible and the original error. Backend idempotency still applies. */
      }
    } finally {
      live.current.sendBusy = false;
      setSendBusy(false);
    }
  }

  async function connected(a: Account, fs: Folder[]) {
    ++requestId.current;
    ++bodyId.current;
    setAccount(a);
    setDemo(false);
    setFolders(fs);
    setFolder("INBOX");
    setMessages([]);
    setSelected(null);
    setMessage(null);
    setSetup(false);
    setView("mail");
    setBusy(true);
    setError("");
    try {
      const result = await invoke<Snapshot>("list_messages", {
        folder: "INBOX",
      });
      setMessages(result.messages);
      setUidValidity(result.uidValidity);
      setOffline(result.offline);
      if (result.warning) setError(result.warning);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F5" && !modalOpen && !busy) {
        e.preventDefault();
        void refresh();
      }
      if (e.ctrlKey && e.key.toLowerCase() === "n" && !modalOpen) {
        e.preventDefault();
        void compose("new");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const visible = messages.filter(
    (m) =>
      (filter === "all" || (filter === "unread" ? m.unread : m.flagged)) &&
      `${m.subject} ${m.from} ${m.to}`
        .toLocaleLowerCase(locale)
        .includes(query.toLocaleLowerCase(locale)),
  );
  const folderLabel = (f: Folder) =>
    f.name === "INBOX" ? t("Posteingang") : demo ? t(f.label) : f.label;
  const currentFolder = folders.find((f) => f.name === folder);
  const currentLabel = currentFolder ? folderLabel(currentFolder) : folder;
  const selectedMail = messages.find((m) => m.uid === selected);
  const unread = messages.filter((m) => m.unread).length;
  const identity = demo ? "martin.berger@example.org" : account?.email;

  return (
    <div className={`app ${dense ? "dense" : ""}`}>
      <header className="titlebar">
        <div className="brand">
          <span className="brand-icon">
            <MailIcon size={17} />
          </span>
          <b>email</b>
        </div>
        <span className="window-title">
          {view === "mail" ? currentLabel : t("Kalender")} –{" "}
          {demo ? t("Demopostfach") : account?.name || account?.email}
        </span>
        <span className="version">
          {t("VORSCHAU")} {version}
        </span>
      </header>
      <nav className="tabs" aria-label={t("Menüband")}>
        <button
          className={`file-tab ${tab === "Datei" ? "active" : ""}`}
          onClick={() => {
            setTab("Datei");
            setSetup(true);
          }}
        >
          {t("Datei")}{" "}
        </button>
        {["Start", "Senden/Empfangen", "Ansicht"].map((tabId) => (
          <button
            key={tabId}
            className={tab === tabId ? "active" : ""}
            onClick={() => setTab(tabId)}
          >
            {t(tabId)}
          </button>
        ))}
        <button
          className="preferences-button"
          onClick={() => setPreferencesOpen(true)}
        >
          <Settings size={15} /> {t("Einstellungen")}
          {["available", "ready", "restart"].includes(updates.status) && (
            <span className="update-dot" aria-label={t("Update verfügbar")} />
          )}
        </button>
        <button
          className="help"
          aria-label={t("Über email")}
          onClick={() =>
            setNotice(`email ${version} · Apache-2.0 · IMAP / SMTP · redb`)
          }
        >
          <CircleHelp size={16} />
        </button>
      </nav>
      <section className="ribbon" aria-label={t("Werkzeuge")}>
        {tab === "Ansicht" ? (
          <>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={<PanelRight size={29} />}
                  onClick={() => setReading(!reading)}
                >
                  {t("Lesebereich")} <br />
                  {reading ? t("ausblenden") : t("einblenden")}
                </Tool>
                <Tool
                  large
                  icon={<ListFilter size={29} />}
                  onClick={() => setDense(!dense)}
                >
                  {dense ? t("Normale") : t("Kompakte")}
                  <br />
                  {t("Ansicht")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Layout")} </div>
            </div>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={<CalendarDays size={29} />}
                  onClick={() => setView("calendar")}
                >
                  {t("Kalender")}{" "}
                </Tool>
                <Tool
                  large
                  icon={<MailIcon size={29} />}
                  onClick={() => setView("mail")}
                >
                  {t("E-Mail")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Navigation")} </div>
            </div>
          </>
        ) : tab === "Senden/Empfangen" ? (
          <>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={<RefreshCw size={30} className={busy ? "spin" : ""} />}
                  onClick={() => void refresh()}
                  disabled={busy}
                >
                  {t("Ordner")} <br />
                  {t("aktualisieren")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Empfangen")} </div>
            </div>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={<Settings size={29} />}
                  onClick={() => setSetup(true)}
                >
                  {t("Kontoeinstellungen")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Einrichten")} </div>
            </div>
            <p className="ribbon-hint">
              {t("IMAP für Ihre Nachrichten.")} <br />
              {t("SMTP für den Versand.")}{" "}
            </p>
          </>
        ) : (
          <>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={
                    <span className="new-mail-icon">
                      <MailIcon size={33} />
                      <Plus size={15} />
                    </span>
                  }
                  onClick={() => void compose("new")}
                >
                  {t("Neue")} <br />
                  {t("E-Mail")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Neu")} </div>
            </div>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={<Trash2 size={29} className="red-icon" />}
                  onClick={() => void moveMail(targetFor("trash"))}
                  disabled={
                    busy ||
                    !selectedMail ||
                    !targetFor("trash") ||
                    folder === targetFor("trash")
                  }
                  title={t("In den Papierkorb verschieben")}
                >
                  {t("Löschen")}{" "}
                </Tool>
                <div className="tool-stack manage-stack">
                  <Tool
                    icon={<Archive size={18} />}
                    disabled={
                      busy ||
                      !selectedMail ||
                      !targetFor("archive") ||
                      folder === targetFor("archive")
                    }
                    onClick={() => void moveMail(targetFor("archive"))}
                  >
                    {t("Archivieren")}{" "}
                  </Tool>
                  <Tool
                    icon={<ShieldAlert size={18} />}
                    disabled={
                      busy ||
                      !selectedMail ||
                      !targetFor("junk") ||
                      folder === targetFor("junk")
                    }
                    onClick={() => void moveMail(targetFor("junk"))}
                  >
                    {t("Junk-E-Mail")}{" "}
                  </Tool>
                  <select
                    className="move-select"
                    aria-label={t("Verschieben nach")}
                    value={moveTarget}
                    disabled={busy || !selectedMail}
                    onChange={(e) => {
                      const target = e.target.value;
                      setMoveTarget("");
                      void moveMail(target);
                    }}
                  >
                    <option value="">{t("Verschieben nach")}</option>
                    {folders
                      .filter((f) => f.selectable && f.name !== folder)
                      .map((f) => (
                        <option key={f.name} value={f.name}>
                          {folderLabel(f)}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="group-label">{t("Verwalten")} </div>
            </div>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={<Reply size={30} className="purple-icon" />}
                  disabled={!message}
                  onClick={() => void compose("reply")}
                >
                  {t("Antworten")}{" "}
                </Tool>
                <Tool
                  large
                  icon={<Forward size={30} className="blue-icon" />}
                  disabled={!message}
                  onClick={() => void compose("forward")}
                >
                  {t("Weiterleiten")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Antworten")} </div>
            </div>
            <div className="ribbon-group">
              <div className="tools">
                <div className="tool-stack">
                  <Tool
                    icon={<MailOpen size={18} />}
                    disabled={!selectedMail || busy || offline}
                    onClick={() => void setFlag("seen")}
                  >
                    {selectedMail?.unread
                      ? t("Als gelesen")
                      : t("Als ungelesen")}
                  </Tool>
                  <Tool
                    icon={<Flag size={18} className="red-icon" />}
                    disabled={!selectedMail || busy || offline}
                    onClick={() => void setFlag("flagged")}
                  >
                    {t("Zur Nachverfolgung")}{" "}
                  </Tool>
                </div>
              </div>
              <div className="group-label">{t("Markierungen")} </div>
            </div>
            <div className="ribbon-group">
              <div className="tools">
                <Tool
                  large
                  icon={
                    <RefreshCw
                      size={28}
                      className={busy ? "spin blue-icon" : "blue-icon"}
                    />
                  }
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  {t("Senden /")} <br />
                  {t("Empfangen")}{" "}
                </Tool>
              </div>
              <div className="group-label">{t("Synchronisieren")} </div>
            </div>
            <div className="ribbon-end">
              <Tool
                icon={<Settings size={19} />}
                onClick={() => setSetup(true)}
              >
                {t("Konto einrichten")}{" "}
              </Tool>
            </div>
          </>
        )}
      </section>
      {demo && (
        <div className="demo-bar">
          <Monitor size={14} />
          <span>
            <b>{t("Demopostfach")} </b>
            {t("· Lernen Sie email mit Beispielnachrichten kennen.")}{" "}
          </span>
          <button onClick={() => setSetup(true)}>
            {t("Eigenes Konto einrichten")} <ChevronRight size={14} />
          </button>
        </div>
      )}
      {error && (
        <div className="error-bar" role="alert">
          <ShieldAlert size={16} />
          <span>{t(error)}</span>
          <button
            aria-label={t("Fehlermeldung schließen")}
            onClick={() => setError("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      <main className="workspace">
        <aside className="sidebar">
          {!demo && (
            <button
              className="local-work-button"
              onClick={() => {
                setError("");
                setWorkOpen(true);
              }}
            >
              <FilePenLine size={16} />
              {t("Lokale Entwürfe & Versand")}
            </button>
          )}
          <div className="sidebar-heading">
            {view === "mail" ? t("E-Mail") : t("Kalender")}
            <ChevronDown size={14} />
          </div>
          {view === "mail" ? (
            <>
              <div className="tree-section">
                <div className="tree-heading">
                  <ChevronDown size={13} />
                  {t("Favoriten")}{" "}
                </div>
                <button
                  className={`folder ${folder === "INBOX" ? "chosen" : ""}`}
                  disabled={!demo && busy}
                  onClick={() => selectFolder("INBOX")}
                >
                  <Inbox size={17} />
                  <span>{t("Posteingang")} </span>
                  {folder === "INBOX" && unread > 0 && <b>{unread}</b>}
                </button>
              </div>
              <div className="tree-section account-tree">
                <div className="tree-heading" title={identity}>
                  <ChevronDown size={13} />
                  <span>
                    {demo ? t("Demopostfach") : account?.name || identity}
                  </span>
                </div>
                {folders.map((f, i) => {
                  const Icon = demo
                    ? (icons[i] ?? FolderIcon)
                    : f.name === "INBOX"
                      ? Inbox
                      : FolderIcon;
                  return (
                    <button
                      key={f.name}
                      disabled={!f.selectable || (!demo && busy)}
                      title={f.name}
                      className={`folder ${folder === f.name ? "chosen" : ""}`}
                      onClick={() => selectFolder(f.name)}
                    >
                      <Icon size={17} />
                      <span>{folderLabel(f)}</span>
                      {f.name === folder && unread > 0 && <b>{unread}</b>}
                    </button>
                  );
                })}
              </div>
              <div className="sidebar-note">
                <LockKeyhole size={14} />
                <span>
                  {demo
                    ? t("Ihre E-Mails. Ihr Rechner.")
                    : t("Lokaler Speicher: redb")}
                  <small>
                    {demo
                      ? t("Demo ohne Serververbindung.")
                      : t(
                          "Kennwort im Schlüsselspeicher oder nur für diese Sitzung.",
                        )}
                  </small>
                </span>
              </div>
            </>
          ) : (
            <div className="calendar-sidebar">
              <MiniCalendar />
              <div className="tree-heading">
                <ChevronDown size={13} />
                {t("Meine Kalender")}{" "}
              </div>
              <div className="calendar-key">
                <span />
                {t("Kalendervorschau")}{" "}
              </div>
              <p>
                {t(
                  "CalDAV ist optional. Die Serverprüfung finden Sie in den Kontoeinstellungen.",
                )}{" "}
              </p>
              <button
                className="standard-button"
                onClick={() => setSetup(true)}
              >
                {t("CalDAV einrichten")}{" "}
              </button>
            </div>
          )}
          <div className="navigation">
            <button
              className={view === "mail" ? "chosen" : ""}
              onClick={() => setView("mail")}
            >
              <MailIcon size={21} />
              <span>{t("E-Mail")} </span>
            </button>
            <button
              className={view === "calendar" ? "chosen" : ""}
              onClick={() => setView("calendar")}
            >
              <CalendarDays size={21} />
              <span>{t("Kalender")} </span>
            </button>
            <button
              className="nav-settings"
              title={t("Kontoeinstellungen")}
              aria-label={t("Kontoeinstellungen")}
              onClick={() => setSetup(true)}
            >
              <Settings size={19} />
            </button>
          </div>
        </aside>
        {view === "calendar" ? (
          <CalendarView />
        ) : (
          <div className="mail-area">
            <div className="mail-heading">
              <div>
                <h1>{currentLabel}</h1>
                <span>{identity}</span>
              </div>
              <label className="search">
                <Search size={16} />
                <input
                  placeholder={t("Diesen Ordner durchsuchen")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label={t("Diesen Ordner durchsuchen")}
                />
                {query && (
                  <button
                    aria-label={t("Suche löschen")}
                    onClick={() => setQuery("")}
                  >
                    <X size={14} />
                  </button>
                )}
                <span className="search-scope">{t("Absender / Betreff")} </span>
              </label>
            </div>
            <div className={`mail-panes ${reading ? "" : "without-reading"}`}>
              <section className="message-list" aria-label={t("Nachrichten")}>
                <div className="list-toolbar">
                  <div className="list-tabs">
                    <button
                      className={filter === "all" ? "chosen" : ""}
                      onClick={() => setFilter("all")}
                    >
                      {t("Alle")}{" "}
                    </button>
                    <button
                      className={filter === "unread" ? "chosen" : ""}
                      onClick={() => setFilter("unread")}
                    >
                      {t("Ungelesen")}{" "}
                    </button>
                    <button
                      title={t("Markierte Nachrichten")}
                      aria-label={t("Markierte Nachrichten")}
                      className={filter === "flagged" ? "chosen" : ""}
                      onClick={() => setFilter("flagged")}
                    >
                      <Flag size={13} />
                    </button>
                  </div>
                  <span>
                    {t("Neueste zuerst")} <ChevronDown size={12} />
                  </span>
                </div>
                <div className="list-group">
                  <ChevronDown size={12} />
                  {query
                    ? t("{count} Suchergebnisse", { count: visible.length })
                    : demo
                      ? t("Nachrichten")
                      : t("Letzte 100 Nachrichten")}
                  <span>{visible.length}</span>
                </div>
                <div className="mail-scroll">
                  {busy && !messages.length ? (
                    <div className="empty">
                      <RefreshCw className="spin" />
                      <p>{t("Nachrichten werden geladen …")} </p>
                    </div>
                  ) : visible.length === 0 ? (
                    <div className="empty">
                      <Inbox size={34} />
                      <h3>
                        {query || filter !== "all"
                          ? t("Keine passenden Nachrichten")
                          : t("Dieser Ordner ist leer")}
                      </h3>
                      <p>
                        {query || filter !== "all"
                          ? t("Ändern Sie den Suchbegriff oder den Filter.")
                          : t("Hier erscheinen Ihre Nachrichten.")}
                      </p>
                    </div>
                  ) : (
                    visible.map((m) => (
                      <button
                        key={m.uid}
                        disabled={!demo && busy}
                        className={`mail-row ${m.unread ? "unread" : ""} ${selected === m.uid ? "selected" : ""}`}
                        onClick={() => void openMail(m)}
                      >
                        <div className="mail-indicator">
                          {m.unread ? <span /> : <MailOpen size={13} />}
                        </div>
                        <div className="row-content">
                          <div className="row-top">
                            <span>{senderName(m.from)}</span>
                            <time>{shortDate(m.date, locale)}</time>
                          </div>
                          <div className="row-subject">
                            <span>{m.subject}</span>
                            {m.flagged && (
                              <Flag size={13} className="red-icon" />
                            )}
                            {!!m.attachments?.length && <Paperclip size={13} />}
                          </div>
                          <div className="row-preview">
                            {m.body
                              ?.split("\n")
                              .filter(Boolean)
                              .slice(1)
                              .join(" ") || emailAddress(m.from)}
                          </div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </section>
              {reading && (
                <article className="reading-pane" aria-label={t("Lesebereich")}>
                  {bodyBusy ? (
                    <div className="empty">
                      <RefreshCw className="spin" />
                      <p>{t("Nachricht wird geladen …")} </p>
                    </div>
                  ) : message ? (
                    <>
                      <div className="reading-actions">
                        <button onClick={() => void compose("reply")}>
                          <Reply size={16} />
                          {t("Antworten")}{" "}
                        </button>
                        <button onClick={() => void compose("forward")}>
                          <Forward size={16} />
                          {t("Weiterleiten")}{" "}
                        </button>
                        <span />
                        <span className="plain-label">
                          {demo
                            ? t("Beispielnachricht")
                            : t("Nur-Text-Ansicht")}
                        </span>
                      </div>
                      <div className="message-header">
                        <h2>{message.subject}</h2>
                        <div className="sender-line">
                          <div className="avatar">
                            {senderName(message.from)
                              .split(" ")
                              .slice(0, 2)
                              .map((s) => s[0])
                              .join("")}
                          </div>
                          <div className="sender-details">
                            <b>{senderName(message.from)}</b>
                            <span>&lt;{emailAddress(message.from)}&gt;</span>
                            <small>
                              {t("An:")} {message.to}
                            </small>
                          </div>
                          <time>
                            {Number.isNaN(Date.parse(message.date))
                              ? message.date
                              : new Date(message.date).toLocaleString(locale, {
                                  day: "2-digit",
                                  month: "2-digit",
                                  year: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                          </time>
                        </div>
                        {!!message.attachments?.length && (
                          <div className="attachments">
                            {message.attachments.map((a, i) => (
                              <span
                                key={`${a}-${i}`}
                                title={t(
                                  "Anhänge werden in dieser Vorschau nur aufgelistet.",
                                )}
                              >
                                <Paperclip size={15} />
                                {a}
                                <small>
                                  {demo ? t("Beispiel") : t("Anhang")}
                                </small>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="message-body">{message.body}</div>
                      <div className="reading-footer">
                        <ShieldAlert size={13} />
                        {t(
                          "Externe Bilder und aktive Inhalte werden nicht geladen.",
                        )}{" "}
                      </div>
                    </>
                  ) : (
                    <div className="empty reader-empty">
                      <MailOpen size={45} />
                      <h3>{t("Ihre Nachrichten im Blick")} </h3>
                      <p>{t("Wählen Sie eine E-Mail aus der Liste aus.")} </p>
                    </div>
                  )}
                </article>
              )}
            </div>
          </div>
        )}
      </main>
      <footer className="statusbar">
        <span>
          {view === "mail"
            ? t("{count} Elemente", { count: messages.length })
            : t("Kalendervorschau")}
        </span>
        {view === "mail" && (
          <span>{t("{count} ungelesen", { count: unread })}</span>
        )}
        <div className="status-message" role="status">
          {t(notice) ||
            (busy
              ? t("Verbindung wird hergestellt …")
              : demo
                ? t("Bereit")
                : offline
                  ? t("Offline · Gespeicherter Stand")
                  : t("Bereit · Manuelle Aktualisierung"))}
        </div>
        <span className={`connection ${demo || offline ? "demo" : ""}`}>
          <span />
          {demo
            ? t("Demomodus")
            : offline
              ? t("Offline")
              : t("Konto verbunden")}
        </span>
        <button
          title={t("Lesebereich umschalten")}
          aria-label={t("Lesebereich umschalten")}
          onClick={() => setReading(!reading)}
        >
          <PanelRight size={15} />
        </button>
        <span>100 %</span>
      </footer>
      {workOpen && account && (
        <LocalWorkDialog
          account={account}
          onClose={() => setWorkOpen(false)}
          onBusy={setSendBusy}
          onOpen={(saved) => {
            setWorkOpen(false);
            setDraft(saved);
            setDraftSaved(true);
            setSentFolder(saved.sentFolder ?? targetFor("sent"));
            setError("");
          }}
        />
      )}
      {preferencesOpen && (
        <SettingsDialog
          onClose={() => setPreferencesOpen(false)}
          updates={updates}
          hasOpenWork={hasOpenWork}
        />
      )}
      {setup && (
        <AccountDialog
          initial={account ?? emptyAccount}
          onClose={() => {
            setSetup(false);
            if (tab === "Datei") setTab("Start");
          }}
          onConnected={connected}
        />
      )}
      {draft && (
        <div className="modal-backdrop">
          <div
            className="compose-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compose-title"
          >
            <div className="dialog-title">
              <span id="compose-title">
                <MailIcon size={16} />
                {t("Neue Nachricht")} {demo ? " · Demo" : ""}
              </span>
              <button
                aria-label={t("Nachricht schließen")}
                disabled={sendBusy}
                onClick={() => {
                  if (demo) setDraft(null);
                  else void saveDraft(true);
                }}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={send}>
              <div className="compose-toolbar">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={sendBusy}
                >
                  <Send size={16} />
                  {sendBusy
                    ? t("Wird versendet …")
                    : demo
                      ? t("Demo-Versand")
                      : t("Senden")}
                </button>
                <button
                  className="standard-button"
                  type="button"
                  disabled={sendBusy}
                  onClick={() => void saveDraft()}
                >
                  <Save size={15} />
                  {draftSaved ? t("Gespeichert") : t("Entwurf speichern")}
                </button>
              </div>
              <p className="compose-from">
                {t("Von:")} {identity}
              </p>
              {!demo && (
                <label className="compose-field">
                  <span>{t("Gesendet-Kopie")}</span>
                  <select
                    required
                    value={sentFolder}
                    disabled={sendBusy}
                    onChange={(e) => {
                      setSentFolder(e.target.value);
                      setDraft({
                        ...draft,
                        revision: draft.revision + 1,
                        sentFolder: e.target.value,
                      });
                      setDraftSaved(false);
                    }}
                  >
                    <option value="">{t("Ordner auswählen")}</option>
                    {folders
                      .filter((f) => f.selectable)
                      .map((f) => (
                        <option key={f.name} value={f.name}>
                          {folderLabel(f)}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label className="compose-field">
                <span>{t("An")} </span>
                <input
                  required
                  type="email"
                  multiple
                  value={draft.to}
                  placeholder={t("empfaenger@beispiel.de")}
                  disabled={sendBusy}
                  onChange={(e) => {
                    setDraft({
                      ...draft,
                      revision: draft.revision + 1,
                      to: e.target.value,
                    });
                    setDraftSaved(false);
                  }}
                  autoFocus
                />
              </label>
              <label className="compose-field">
                <span>{t("Betreff")} </span>
                <input
                  required
                  value={draft.subject}
                  disabled={sendBusy}
                  onChange={(e) => {
                    setDraft({
                      ...draft,
                      revision: draft.revision + 1,
                      subject: e.target.value,
                    });
                    setDraftSaved(false);
                  }}
                />
              </label>
              <textarea
                aria-label={t("Nachrichtentext")}
                required
                value={draft.body}
                disabled={sendBusy}
                onChange={(e) => {
                  setDraft({
                    ...draft,
                    revision: draft.revision + 1,
                    body: e.target.value,
                  });
                  setDraftSaved(false);
                }}
                placeholder={t("Ihre Nachricht …")}
              />
              {error && (
                <p className="form-error" role="alert">
                  {t(error)}
                </p>
              )}
              <div className="compose-note">
                {demo
                  ? t(
                      "In der Demo werden keine E-Mails versendet. Entwürfe bleiben nur in diesem Fenster.",
                    )
                  : t(
                      "Entwürfe werden automatisch lokal gespeichert. Gesendete Nachrichten werden im gewählten IMAP-Ordner abgelegt.",
                    )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountDialog({
  initial,
  onClose,
  onConnected,
}: {
  initial: Account;
  onClose: () => void;
  onConnected: (a: Account, fs: Folder[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const [a, setA] = useState({ ...initial });
  const [password, setPassword] = useState("");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const update = <K extends keyof Account>(key: K, value: Account[K]) =>
    setA((old) => ({ ...old, [key]: value }));
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!desktop) {
      setError(
        t(
          "Die Browseransicht zeigt die Oberfläche. Starten Sie die Desktop-App mit „npm run desktop“, um ein echtes Konto zu verbinden.",
        ),
      );
      return;
    }
    setBusy(true);
    setError("");
    setResult("");
    try {
      const normalized = {
        ...a,
        username: a.username || a.email,
        smtpUsername: a.smtpUsername || a.username || a.email,
      };
      const fs = await invoke<Folder[]>("connect_account", {
        account: normalized,
        password,
        smtpPassword,
      });
      setPassword("");
      setSmtpPassword("");
      await onConnected(normalized, fs);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function probe() {
    if (!desktop) {
      setError(t("Die CalDAV-Prüfung ist in der Desktop-App verfügbar."));
      return;
    }
    setBusy(true);
    setError("");
    setResult("");
    try {
      setResult(await invoke<string>("probe_caldav", { url: a.caldavUrl }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
      >
        <div className="dialog-title">
          <span>
            <Settings size={16} />
            {t("Kontoeinstellungen")}{" "}
          </span>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label={t("Kontoeinstellungen schließen")}
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={connect}>
          <fieldset disabled={busy} className="account-fieldset">
            <div className="account-intro">
              <span className="account-symbol">
                <MailIcon size={29} />
              </span>
              <div>
                <h2 id="account-title">{t("Ihr E-Mail-Konto einrichten")} </h2>
                <p>
                  {t(
                    "Die Zugangsdaten erhalten Sie von Ihrem E-Mail-Anbieter.",
                  )}{" "}
                </p>
              </div>
            </div>
            <div className="form-grid">
              <label>
                {t("Ihr Name")}{" "}
                <input
                  autoFocus
                  required
                  value={a.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder={t("Vorname Nachname")}
                  autoComplete="name"
                />
              </label>
              <label>
                {t("E-Mail-Adresse")}{" "}
                <input
                  type="email"
                  required
                  value={a.email}
                  onChange={(e) => update("email", e.target.value)}
                  placeholder={t("name@firma.de")}
                  autoComplete="email"
                />
              </label>
              <label>
                {t("Benutzername")}{" "}
                <input
                  value={a.username}
                  onChange={(e) => update("username", e.target.value)}
                  placeholder={t("Wie E-Mail-Adresse")}
                  autoComplete="username"
                />
              </label>
              <label>
                {t("Kennwort")}{" "}
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={
                    initial.email
                      ? t("Gespeichertes Kennwort verwenden")
                      : t("Kennwort oder App-Passwort")
                  }
                  autoComplete="current-password"
                />
              </label>
            </div>
            <div className="server-section">
              <h3>
                {t("Posteingang")} <span>{t("IMAP")} </span>
              </h3>
              <div className="server-grid">
                <label>
                  {t("Server")}{" "}
                  <input
                    required
                    value={a.imapHost}
                    onChange={(e) => update("imapHost", e.target.value)}
                    placeholder={t("imap.firma.de")}
                  />
                </label>
                <label>
                  {t("Port")}{" "}
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    required
                    value={a.imapPort}
                    onChange={(e) => update("imapPort", Number(e.target.value))}
                  />
                </label>
                <label>
                  {t("Verschlüsselung")}{" "}
                  <select
                    value={a.imapSecurity}
                    onChange={(e) => {
                      update(
                        "imapSecurity",
                        e.target.value as "tls" | "starttls",
                      );
                      update("imapPort", e.target.value === "tls" ? 993 : 143);
                    }}
                  >
                    <option value="tls">{t("SSL/TLS")} </option>
                    <option value="starttls">{t("STARTTLS")} </option>
                  </select>
                </label>
              </div>
            </div>
            <div className="server-section">
              <h3>
                {t("Postausgang")} <span>{t("SMTP")} </span>
              </h3>
              <div className="server-grid">
                <label>
                  {t("Server")}{" "}
                  <input
                    required
                    value={a.smtpHost}
                    onChange={(e) => update("smtpHost", e.target.value)}
                    placeholder={t("smtp.firma.de")}
                  />
                </label>
                <label>
                  {t("Port")}{" "}
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    required
                    value={a.smtpPort}
                    onChange={(e) => update("smtpPort", Number(e.target.value))}
                  />
                </label>
                <label>
                  {t("Verschlüsselung")}{" "}
                  <select
                    value={a.smtpSecurity}
                    onChange={(e) => {
                      update(
                        "smtpSecurity",
                        e.target.value as "tls" | "starttls",
                      );
                      update("smtpPort", e.target.value === "tls" ? 465 : 587);
                    }}
                  >
                    <option value="starttls">{t("STARTTLS")} </option>
                    <option value="tls">{t("SSL/TLS")} </option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setAdvanced(!advanced)}
              >
                {advanced ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )}
                {t("Abweichende SMTP-Zugangsdaten")}{" "}
              </button>
              {advanced && (
                <div className="form-grid">
                  <label>
                    {t("SMTP-Benutzername")}{" "}
                    <input
                      value={a.smtpUsername}
                      onChange={(e) => update("smtpUsername", e.target.value)}
                      placeholder={t("Wie IMAP-Benutzername")}
                    />
                  </label>
                  <label>
                    {t("SMTP-Kennwort")}{" "}
                    <input
                      type="password"
                      value={smtpPassword}
                      onChange={(e) => setSmtpPassword(e.target.value)}
                      placeholder={t(
                        "Wie IMAP-Kennwort / gespeichertes Kennwort",
                      )}
                    />
                  </label>
                </div>
              )}
            </div>
            <div className="caldav-section">
              <h3>
                <CalendarDays size={16} />
                {t("Kalender")} <span>{t("Optional · CalDAV")} </span>
              </h3>
              <div className="caldav-input">
                <input
                  type="url"
                  aria-label={t("CalDAV-Adresse")}
                  value={a.caldavUrl}
                  onChange={(e) => update("caldavUrl", e.target.value)}
                  placeholder={t(
                    "https://kalender.firma.de/.well-known/caldav",
                  )}
                />
                <button
                  type="button"
                  className="standard-button"
                  disabled={!a.caldavUrl}
                  onClick={() => void probe()}
                >
                  {t("Server prüfen")}{" "}
                </button>
              </div>
              <p>
                {t(
                  "Prüft den Endpunkt ohne Zugangsdaten. Kalendersynchronisation folgt.",
                )}{" "}
              </p>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={a.rememberPassword}
                onChange={(e) => update("rememberPassword", e.target.checked)}
              />
              <span>
                {t("Kennwort im Betriebssystem-Schlüsselspeicher merken")}{" "}
              </span>
            </label>
            {!a.rememberPassword && (
              <p className="field-note">
                {t(
                  "Neue Kennwörter gelten nur für diese Sitzung. Bereits gespeicherte Kennwörter bleiben im Schlüsselspeicher.",
                )}{" "}
              </p>
            )}
            {error && (
              <div className="form-error" role="alert">
                {t(error)}
              </div>
            )}
            {result && (
              <div className="form-result" role="status">
                {t(result)}
              </div>
            )}
          </fieldset>
          <div className="dialog-footer">
            <span>
              <LockKeyhole size={14} />
              {t("Verschlüsselte Verbindung")}{" "}
            </span>
            <button
              type="button"
              className="standard-button"
              onClick={onClose}
              disabled={busy}
            >
              {t("Abbrechen")}{" "}
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? (
                <RefreshCw size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}{" "}
              {busy ? t("Wird geprüft …") : t("Prüfen & verbinden")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MiniCalendar() {
  const { locale } = useI18n();
  const d = new Date();
  return (
    <div className="mini-calendar">
      <b>{d.toLocaleDateString(locale, { month: "long", year: "numeric" })}</b>
      <div>
        {Array.from({ length: 7 }, (_, i) =>
          new Date(2026, 0, 5 + i).toLocaleDateString(locale, {
            weekday: "narrow",
          }),
        ).map((s, i) => (
          <small key={i}>{s}</small>
        ))}
        {Array.from(
          {
            length:
              (new Date(d.getFullYear(), d.getMonth(), 1).getDay() + 6) % 7,
          },
          (_, i) => (
            <span key={`pad-${i}`} />
          ),
        )}
        {Array.from(
          { length: new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() },
          (_, i) => (
            <span className={i + 1 === d.getDate() ? "today" : ""} key={i}>
              {i + 1}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function CalendarView() {
  const { t, locale } = useI18n();
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const start = (month.getDay() + 6) % 7;
  const today = new Date();
  return (
    <section className="calendar-view">
      <div className="calendar-toolbar">
        <h1>
          {month.toLocaleDateString(locale, {
            month: "long",
            year: "numeric",
          })}
        </h1>
        <button
          className="standard-button"
          onClick={() =>
            setMonth(new Date(today.getFullYear(), today.getMonth(), 1))
          }
        >
          {t("Heute")}{" "}
        </button>
        <button
          aria-label={t("Vorheriger Monat")}
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
          }
        >
          <ChevronLeft size={18} />
        </button>
        <button
          aria-label={t("Nächster Monat")}
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }
        >
          <ChevronRight size={18} />
        </button>
        <span>{t("Monat")} </span>
      </div>
      <div className="calendar-info">
        <Clock3 size={15} />
        {t(
          "Kalendervorschau · Noch keine Termine oder CalDAV-Synchronisation",
        )}{" "}
      </div>
      <div className="weekdays">
        {[
          t("Montag"),
          t("Dienstag"),
          t("Mittwoch"),
          t("Donnerstag"),
          t("Freitag"),
          t("Samstag"),
          t("Sonntag"),
        ].map((day) => (
          <b key={day}>{day}</b>
        ))}
      </div>
      <div className="month-grid">
        {Array.from({ length: 42 }, (_, i) => {
          const d = new Date(
            month.getFullYear(),
            month.getMonth(),
            i - start + 1,
          );
          return (
            <div
              key={i}
              className={`${d.getMonth() !== month.getMonth() ? "other-month" : ""} ${d.toDateString() === today.toDateString() ? "today" : ""}`}
            >
              <span>{d.getDate()}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
