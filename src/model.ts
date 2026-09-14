export interface Account {
  name: string;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: "tls" | "starttls";
  smtpUsername: string;
  caldavUrl: string;
  rememberPassword: boolean;
}
export interface Folder {
  name: string;
  label: string;
  selectable: boolean;
  role?: string | null;
}
export interface Mail {
  uid: number;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
  flagged: boolean;
  size: number;
  body?: string | null;
  html?: string | null;
  htmlWarning?: string | null;
  bodyVersion?: number;
  links?: string[];
  attachments?: string[];
  attachmentSizes?: number[];
}
export interface AttachmentRef {
  id: string;
  name: string;
  size: number;
}
export interface Draft {
  attachments?: AttachmentRef[];
  id: string;
  revision: number;
  sentFolder?: string | null;
  to: string;
  subject: string;
  body: string;
}
export interface Submission {
  draft: Draft;
  status: "sending" | "uncertain" | "rejected" | "copy_pending" | "complete";
  sentFolder: string;
  detail?: string | null;
}
export function accountIdentity(account: Account) {
  return JSON.stringify([account.imapHost, account.imapPort, account.username]);
}
export const emptyAccount: Account = {
  name: "",
  email: "",
  username: "",
  imapHost: "",
  imapPort: 993,
  imapSecurity: "tls",
  smtpHost: "",
  smtpPort: 587,
  smtpSecurity: "starttls",
  smtpUsername: "",
  caldavUrl: "",
  rememberPassword: true,
};
export const demoFolders: Folder[] = [
  { name: "INBOX", label: "Posteingang", selectable: true },
  { name: "Drafts", label: "Entwürfe", selectable: true },
  { name: "Sent", label: "Gesendet", selectable: true },
  { name: "Archive", label: "Archiv", selectable: true },
  { name: "Junk", label: "Junk-E-Mail", selectable: true },
  { name: "Trash", label: "Gelöscht", selectable: true },
];
const today = new Date();
function date(days: number, hour: number, minute = 0) {
  const d = new Date(today);
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
export const demoMail: Mail[] = [
  {
    uid: 8,
    from: "Anna Weber <anna.weber@example.org>",
    replyTo: "anna.weber@example.org",
    to: "martin.berger@example.org",
    subject: "Abstimmung zum neuen Empfangsbereich",
    date: date(0, 10, 42),
    unread: true,
    flagged: true,
    size: 4200,
    body: "Guten Morgen Herr Berger,\n\nanbei erhalten Sie den aktualisierten Entwurf für unseren Empfangsbereich. Die besprochenen Änderungen haben wir bereits berücksichtigt.\n\nBesonders bei der Materialauswahl würden wir uns über Ihre Einschätzung freuen. Passt Ihnen ein kurzer Termin am Donnerstag um 10:00 Uhr?\n\nVielen Dank und herzliche Grüße\n\nAnna Weber\nProjektkoordination\n\nWE BER · Architektur & Räume\nMusterstraße 12 · 10115 Berlin\n\nDies ist eine Beispielnachricht in der Demo. Es werden keine Nachrichten empfangen oder versendet.",
    bodyVersion: 1,
    html: "<p>Guten Morgen Herr Berger,</p><p>anbei erhalten Sie den <strong>aktualisierten Entwurf</strong> für unseren Empfangsbereich. Die besprochenen Änderungen haben wir bereits berücksichtigt.</p><h3>Abstimmung zum Empfangsbereich</h3><table><tbody><tr><th>Thema</th><th>Nächster Schritt</th></tr><tr><td>Materialauswahl</td><td>Ihre Einschätzung</td></tr><tr><td>Kurzer Termin</td><td>Donnerstag, 10:00 Uhr</td></tr></tbody></table><p>Passt Ihnen der vorgeschlagene Termin?</p><p>Vielen Dank und herzliche Grüße<br><strong>Anna Weber</strong><br>Projektkoordination</p><blockquote>WE BER · Architektur &amp; Räume<br>Musterstraße 12 · 10115 Berlin</blockquote><p><small>Dies ist eine Beispielnachricht in der Demo. Es werden keine Nachrichten empfangen oder versendet.</small></p>",
    links: ["https://example.org/"],
    attachments: ["Entwurf_Empfang.pdf"],
  },
  {
    uid: 7,
    from: "Thomas Fischer <thomas.fischer@example.org>",
    replyTo: "thomas.fischer@example.org",
    to: "martin.berger@example.org",
    subject: "Angebot Nr. 2026-084 · Ihre Rückmeldung",
    date: date(0, 9, 18),
    unread: true,
    flagged: false,
    size: 2100,
    body: "Hallo Martin,\n\nhattest du schon Gelegenheit, dir unser Angebot anzusehen? Bei Fragen melde dich gerne.\n\nViele Grüße\nThomas",
  },
  {
    uid: 6,
    from: "Buchhaltung <buchhaltung@example.org>",
    replyTo: "buchhaltung@example.org",
    to: "martin.berger@example.org",
    subject: "Monatsübersicht August",
    date: date(0, 8, 35),
    unread: false,
    flagged: false,
    size: 1800,
    body: "Guten Morgen,\n\ndie Monatsübersicht ist fertig und liegt wie gewohnt im gemeinsamen Projektordner.\n\nBeste Grüße\nIhre Buchhaltung",
  },
  {
    uid: 5,
    from: "Julia Neumann <julia.neumann@example.org>",
    replyTo: "julia.neumann@example.org",
    to: "martin.berger@example.org",
    subject: "Re: Termin für die Teambesprechung",
    date: date(1, 16, 24),
    unread: false,
    flagged: true,
    size: 1700,
    body: "Hallo zusammen,\n\nDonnerstag passt mir gut. Ich bringe die Unterlagen für die neue Planung mit.\n\nBis dann!\nJulia",
  },
  {
    uid: 4,
    from: "Michael Braun <michael.braun@example.org>",
    replyTo: "michael.braun@example.org",
    to: "martin.berger@example.org",
    subject: "Liefertermin bestätigt",
    date: date(1, 14, 5),
    unread: false,
    flagged: false,
    size: 1900,
    body: "Sehr geehrter Herr Berger,\n\nwir bestätigen die Lieferung für kommenden Dienstag zwischen 09:00 und 12:00 Uhr.\n\nMit freundlichen Grüßen\nMichael Braun",
  },
  {
    uid: 3,
    from: "Sophie Klein <sophie.klein@example.org>",
    replyTo: "sophie.klein@example.org",
    to: "martin.berger@example.org",
    subject: "Bilder vom Sommerfest",
    date: date(1, 11, 12),
    unread: false,
    flagged: false,
    size: 1500,
    body: "Hallo Martin,\n\ndas war ein schöner Abend! Die Bilder habe ich im Teamordner abgelegt.\n\nLiebe Grüße\nSophie",
  },
  {
    uid: 2,
    from: "IT-Service <service@example.org>",
    replyTo: "service@example.org",
    to: "martin.berger@example.org",
    subject: "Wartungsfenster am Wochenende",
    date: date(3, 15, 30),
    unread: false,
    flagged: false,
    size: 1200,
    body: "Guten Tag,\n\nam Samstag werden zwischen 20:00 und 22:00 Uhr Wartungsarbeiten durchgeführt.\n\nIhr IT-Service",
  },
  {
    uid: 1,
    from: "email <willkommen@example.org>",
    replyTo: "willkommen@example.org",
    to: "martin.berger@example.org",
    subject: "Ein vertrauter Platz für Ihre E-Mails",
    date: date(3, 9),
    unread: false,
    flagged: false,
    size: 900,
    body: "Willkommen bei email.\n\nLinks Ihre Ordner, daneben Ihre Nachrichten und hier der Lesebereich. Alles an seinem gewohnten Platz.\n\nÜber „Konto einrichten“ verbinden Sie Ihr IMAP-Postfach. Für den Versand verwenden Sie Ihren SMTP-Server.\n\nDiese Ansicht enthält ausschließlich Beispieldaten.",
  },
];
export function senderName(from: string) {
  return from.split("<")[0].trim().replace(/^"|"$/g, "") || from;
}
export function emailAddress(from: string) {
  return from.match(/<([^>]+)>/)?.[1] || from;
}
export function shortDate(date: string, locale = "de-DE") {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return date;
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}
