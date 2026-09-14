use crate::Result;
use lettre::{
    message::{header::ContentType, Mailbox},
    transport::smtp::authentication::Credentials as SmtpCredentials,
    Message, SmtpTransport,
};
use mailparse::MailHeaderMap;
use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    net::{TcpStream, ToSocketAddrs},
    time::Duration,
};

const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MESSAGE: u32 = 10 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub name: String,
    pub email: String,
    pub username: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub imap_security: Security,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_security: Security,
    pub smtp_username: String,
    pub caldav_url: String,
    pub remember_password: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    Tls,
    Starttls,
}

impl Account {
    pub fn validate(&self) -> Result<()> {
        self.email
            .parse::<Mailbox>()
            .map_err(|_| "Bitte geben Sie eine gültige E-Mail-Adresse ein.")?;
        for host in [&self.imap_host, &self.smtp_host] {
            if host.is_empty()
                || host.len() > 253
                || host
                    .chars()
                    .any(|c| c.is_whitespace() || c.is_control() || "/@?#".contains(c))
            {
                return Err(
                    "Server bitte als Hostnamen oder IP-Adresse eingeben, ohne URL oder Pfad."
                        .into(),
                );
            }
        }
        if self.imap_port == 0 || self.smtp_port == 0 {
            return Err("Der Port muss zwischen 1 und 65535 liegen.".into());
        }
        if self.username.is_empty() || self.smtp_username.is_empty() {
            return Err("Ein Benutzername ist erforderlich.".into());
        }
        Ok(())
    }
    pub fn identity(&self) -> String {
        serde_json::to_string(&(&self.imap_host, self.imap_port, &self.username)).unwrap()
    }
    fn secret_key(&self, smtp: bool) -> String {
        if smtp {
            serde_json::to_string(&("smtp", &self.smtp_host, self.smtp_port, &self.smtp_username))
                .unwrap()
        } else {
            format!("imap:{}", self.identity())
        }
    }
}

// Intentionally neither Debug nor Serialize: secrets never go into logs, IPC responses or redb.
#[derive(Clone)]
pub struct Credentials {
    pub account: Account,
    password: String,
    smtp_password: String,
}
impl Credentials {
    pub fn resolve(
        account: Account,
        mut password: String,
        mut smtp_password: String,
    ) -> Result<Self> {
        if password.is_empty() {
            password = Self::entry(&account, false)?.get_password().map_err(|_| {
                "Kein gespeichertes IMAP-Kennwort verfügbar. Bitte Kennwort eingeben."
            })?;
        }
        if smtp_password.is_empty() {
            smtp_password = Self::entry(&account, true)
                .and_then(|entry| entry.get_password().map_err(|_| String::new()))
                .unwrap_or_else(|_| password.clone());
        }
        Ok(Self {
            account,
            password,
            smtp_password,
        })
    }
    fn entry(a: &Account, smtp: bool) -> Result<keyring::Entry> {
        keyring::Entry::new("de.email.desktop", &a.secret_key(smtp))
            .map_err(|_| "Der Betriebssystem-Schlüsselspeicher ist nicht verfügbar.".into())
    }
    pub fn persist(&self) -> Result<()> {
        // Session-only mode must also work on desktops without a Secret Service.
        // It does not erase previously saved credentials; the UI states that explicitly.
        if !self.account.remember_password {
            return Ok(());
        }
        for (smtp, password) in [(false, &self.password), (true, &self.smtp_password)] {
            let entry = Self::entry(&self.account, smtp)?;
            entry.set_password(password).map_err(|_| "Kennwort konnte nicht im Schlüsselspeicher gespeichert werden. Entsperren Sie ihn oder deaktivieren Sie „Kennwort merken“.")?;
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Folder {
    pub name: String,
    pub label: String,
    pub selectable: bool,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mail {
    pub uid: u32,
    pub from: String,
    pub reply_to: String,
    pub to: String,
    pub subject: String,
    pub date: String,
    pub unread: bool,
    pub flagged: bool,
    pub size: u32,
    pub body: Option<String>,
    pub attachments: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub messages: Vec<Mail>,
    pub uid_validity: u32,
    pub offline: bool,
    pub warning: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    #[serde(default = "new_id")]
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub sent_folder: Option<String>,
    pub to: String,
    pub subject: String,
    pub body: String,
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

type Session = imap::Session<native_tls::TlsStream<TcpStream>>;
pub(crate) fn connect(c: &Credentials) -> Result<Session> {
    let a = &c.account;
    // DNS resolution may take longer than the per-socket timeout. Runs on a blocking worker.
    let addresses = (a.imap_host.as_str(), a.imap_port)
        .to_socket_addrs()
        .map_err(|_| "IMAP-Servername konnte nicht aufgelöst werden.")?;
    let mut stream = None;
    for addr in addresses.take(4) {
        if let Ok(s) = TcpStream::connect_timeout(&addr, TIMEOUT) {
            stream = Some(s);
            break;
        }
    }
    let stream =
        stream.ok_or("IMAP-Server ist nicht erreichbar. Server, Port und Netzwerk prüfen.")?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|e| e.to_string())?;
    let tls =
        native_tls::TlsConnector::new().map_err(|_| "TLS konnte nicht initialisiert werden.")?;
    let client = match a.imap_security {
        Security::Tls => {
            let stream = tls.connect(&a.imap_host, stream).map_err(|_| {
                "IMAP-TLS-Verbindung fehlgeschlagen. Zertifikat und Servername prüfen."
            })?;
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|_| "IMAP-Server antwortet nicht korrekt.")?;
            client
        }
        Security::Starttls => {
            let mut client = imap::Client::new(stream);
            client
                .read_greeting()
                .map_err(|_| "IMAP-Server antwortet nicht korrekt.")?;
            client.secure(&a.imap_host, &tls).map_err(|_| "IMAP-STARTTLS fehlgeschlagen. Es werden keine Zugangsdaten unverschlüsselt gesendet.")?
        }
    };
    client.login(&a.username, &c.password).map_err(|_| {
        "IMAP-Anmeldung fehlgeschlagen. Benutzername, Kennwort oder App-Passwort prüfen.".into()
    })
}

pub fn folders(c: &Credentials) -> Result<Vec<Folder>> {
    let mut session = connect(c)?;
    let names = session
        .list(Some(""), Some("*"))
        .map_err(|_| "IMAP-Ordner konnten nicht abgerufen werden.")?;
    let mut result: Vec<Folder> = names
        .iter()
        .map(|n| Folder {
            name: n.name().into(),
            label: crate::folders::decode_name(n.name()),
            role: crate::folders::role(n.name(), n.attributes()),
            selectable: !n
                .attributes()
                .iter()
                .any(|a| matches!(a, imap::types::NameAttribute::NoSelect)),
        })
        .collect();
    result.sort_by_key(|f| (!f.name.eq_ignore_ascii_case("INBOX"), f.name.clone()));
    let _ = session.logout();
    Ok(result)
}

pub(crate) fn validate_folder(folder: &str) -> Result<()> {
    if folder.is_empty() || folder.chars().any(char::is_control) {
        Err("Ungültiger Ordnername.".into())
    } else {
        Ok(())
    }
}

fn parse_header(raw: &[u8], uid: u32, unread: bool, flagged: bool, size: u32) -> Result<Mail> {
    let (headers, _) = mailparse::parse_headers(raw)
        .map_err(|_| "Nachrichtenkopf konnte nicht gelesen werden.")?;
    let get = |name: &str| headers.get_first_value(name).unwrap_or_default();
    Ok(Mail {
        uid,
        from: get("From"),
        reply_to: get("Reply-To"),
        to: get("To"),
        subject: {
            let s = get("Subject");
            if s.is_empty() {
                "(Kein Betreff)".into()
            } else {
                s
            }
        },
        date: get("Date"),
        unread,
        flagged,
        size,
        body: None,
        attachments: vec![],
    })
}

pub fn list(c: &Credentials, folder: &str) -> Result<Snapshot> {
    validate_folder(folder)?;
    let mut session = connect(c)?;
    let mailbox = session
        .examine(folder)
        .map_err(|_| "Ordner konnte nicht geöffnet werden.")?;
    let validity = mailbox
        .uid_validity
        .ok_or("Server liefert keine UIDVALIDITY; sicherer Cache ist nicht möglich.")?;
    let mut messages = Vec::new();
    if mailbox.exists > 0 {
        let range = format!(
            "{}:{}",
            mailbox.exists.saturating_sub(99).max(1),
            mailbox.exists
        );
        let data = session
            .fetch(
                range,
                "(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM REPLY-TO TO SUBJECT DATE)])",
            )
            .map_err(|_| "Nachrichtenliste konnte nicht abgerufen werden.")?;
        for fetch in data.iter() {
            if let (Some(uid), Some(header)) = (fetch.uid, fetch.header()) {
                messages.push(parse_header(
                    header,
                    uid,
                    !fetch
                        .flags()
                        .iter()
                        .any(|f| matches!(f, imap::types::Flag::Seen)),
                    fetch
                        .flags()
                        .iter()
                        .any(|f| matches!(f, imap::types::Flag::Flagged)),
                    fetch.size.unwrap_or(0),
                )?);
            }
        }
    }
    messages.sort_by_key(|m| std::cmp::Reverse(m.uid));
    let _ = session.logout();
    Ok(Snapshot {
        messages,
        uid_validity: validity,
        offline: false,
        warning: None,
    })
}

pub(crate) fn verify_validity(actual: Option<u32>, expected: u32, uid: u32) -> Result<()> {
    if uid == 0 || expected == 0 || actual != Some(expected) {
        Err("Der Ordner hat sich auf dem Server geändert. Bitte zuerst aktualisieren.".into())
    } else {
        Ok(())
    }
}

pub fn read(c: &Credentials, folder: &str, uid: u32, validity: u32) -> Result<Mail> {
    validate_folder(folder)?;
    let mut session = connect(c)?;
    let mailbox = session
        .examine(folder)
        .map_err(|_| "Ordner konnte nicht geöffnet werden.")?;
    verify_validity(mailbox.uid_validity, validity, uid)?;
    let metadata = session
        .uid_fetch(uid.to_string(), "(UID RFC822.SIZE)")
        .map_err(|_| "Nachricht nicht erreichbar.")?;
    let size = metadata
        .iter()
        .find(|f| f.uid == Some(uid))
        .and_then(|f| f.size)
        .ok_or("Nachricht wurde verschoben oder gelöscht.")?;
    if size > MAX_MESSAGE {
        return Err("Diese Nachricht ist größer als 10 MiB. Große Nachrichten und Anhang-Downloads folgen in einer nächsten Version.".into());
    }
    let data = session
        .uid_fetch(
            uid.to_string(),
            format!("(UID FLAGS RFC822.SIZE BODY.PEEK[]<0.{MAX_MESSAGE}>)"),
        )
        .map_err(|_| "Nachricht konnte nicht abgerufen werden.")?;
    let fetch = data
        .iter()
        .find(|f| f.uid == Some(uid))
        .ok_or("Nachricht ist nicht mehr vorhanden.")?;
    let raw = fetch
        .body()
        .ok_or("Nachricht hat keinen lesbaren Inhalt.")?;
    let mut mail = parse_header(
        raw,
        uid,
        !fetch
            .flags()
            .iter()
            .any(|f| matches!(f, imap::types::Flag::Seen)),
        fetch
            .flags()
            .iter()
            .any(|f| matches!(f, imap::types::Flag::Flagged)),
        size,
    )?;
    let parsed =
        mailparse::parse_mail(raw).map_err(|_| "MIME-Nachricht konnte nicht gelesen werden.")?;
    let mut text = Vec::new();
    collect_parts(&parsed, &mut text, &mut mail.attachments, 0)?;
    mail.body = Some(if text.is_empty() {
        "Diese Nachricht enthält keinen Nur-Text-Inhalt. Sichere HTML-Darstellung folgt in einer nächsten Version.".into()
    } else {
        text.join("\n\n")
    });
    let _ = session.logout();
    Ok(mail)
}

fn collect_parts(
    part: &mailparse::ParsedMail<'_>,
    text: &mut Vec<String>,
    attachments: &mut Vec<String>,
    depth: usize,
) -> Result<()> {
    if depth > 30 {
        return Err("Die MIME-Struktur der Nachricht ist zu tief verschachtelt.".into());
    }
    let disposition = part.get_content_disposition();
    let filename = disposition
        .params
        .get("filename")
        .or_else(|| part.ctype.params.get("name"));
    if disposition.disposition == mailparse::DispositionType::Attachment || filename.is_some() {
        attachments.push(
            filename
                .cloned()
                .unwrap_or_else(|| "Anhang ohne Dateinamen".into()),
        );
        return Ok(());
    }
    if part.ctype.mimetype.eq_ignore_ascii_case("text/plain") {
        text.push(
            part.get_body()
                .map_err(|_| "Zeichensatz der Nachricht konnte nicht gelesen werden.")?,
        );
    }
    for child in &part.subparts {
        collect_parts(child, text, attachments, depth + 1)?;
    }
    Ok(())
}

pub fn set_flag(
    c: &Credentials,
    folder: &str,
    uid: u32,
    validity: u32,
    kind: &str,
    value: bool,
) -> Result<()> {
    validate_folder(folder)?;
    let flag = match kind {
        "seen" => "\\Seen",
        "flagged" => "\\Flagged",
        _ => return Err("Unbekannte Markierung.".into()),
    };
    let mut session = connect(c)?;
    let mailbox = session
        .select(folder)
        .map_err(|_| "Ordner konnte nicht zum Schreiben geöffnet werden.")?;
    verify_validity(mailbox.uid_validity, validity, uid)?;
    session
        .uid_store(
            uid.to_string(),
            format!("{}FLAGS.SILENT ({flag})", if value { "+" } else { "-" }),
        )
        .map_err(|_| "Markierung konnte nicht gespeichert werden.")?;
    let _ = session.logout();
    Ok(())
}

pub(crate) fn smtp(c: &Credentials) -> Result<SmtpTransport> {
    let a = &c.account;
    let builder = match a.smtp_security {
        Security::Tls => SmtpTransport::relay(&a.smtp_host),
        Security::Starttls => SmtpTransport::starttls_relay(&a.smtp_host),
    }
    .map_err(|_| "SMTP-TLS-Konfiguration ist ungültig.")?;
    Ok(builder
        .port(a.smtp_port)
        .timeout(Some(TIMEOUT))
        .credentials(SmtpCredentials::new(
            a.smtp_username.clone(),
            c.smtp_password.clone(),
        ))
        .build())
}

pub fn test_smtp(c: &Credentials) -> Result<()> {
    match smtp(c)?.test_connection() {
        Ok(true) => Ok(()),
        _ => Err("SMTP-Verbindung oder Anmeldung fehlgeschlagen. Server, Port, TLS und Zugangsdaten prüfen. Es wurde keine Nachricht gesendet.".into()),
    }
}

pub(crate) fn build_message(a: &Account, draft: &Draft) -> Result<Message> {
    if draft.body.len() > MAX_MESSAGE as usize {
        return Err("Die Nachricht ist zu groß (maximal 10 MiB).".into());
    }
    if draft.subject.trim().is_empty() || draft.to.trim().is_empty() {
        return Err("Empfänger und Betreff sind erforderlich.".into());
    }
    let mut builder = Message::builder()
        .from(Mailbox::new(
            Some(a.name.clone()),
            a.email
                .parse()
                .map_err(|_| "Absenderadresse ist ungültig.")?,
        ))
        .subject(&draft.subject)
        .message_id(Some(format!("<{}@email.local>", draft.id)));
    for recipient in draft.to.split(',').map(str::trim) {
        builder = builder.to(recipient.parse().map_err(|_| {
            "Eine Empfängeradresse ist ungültig. Mehrere Adressen mit Komma trennen."
        })?);
    }
    builder
        .header(ContentType::TEXT_PLAIN)
        .body(draft.body.clone())
        .map_err(|_| "Nachricht konnte nicht erstellt werden.".into())
}

pub fn probe_caldav(url: &str) -> Result<String> {
    let mut url =
        reqwest::Url::parse(url).map_err(|_| "Bitte eine gültige HTTPS-Adresse eingeben.")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("CalDAV benötigt eine HTTPS-Adresse ohne eingebettete Zugangsdaten.".into());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    for _ in 0..5 {
        let response = client.request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), url.clone()).header("Depth", "0").header("Content-Type", "application/xml; charset=utf-8")
            .body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/></d:prop></d:propfind>")
            .send().map_err(|_| "CalDAV-Endpunkt nicht erreichbar oder TLS-Zertifikat ungültig.")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("Location")
                .and_then(|v| v.to_str().ok())
                .ok_or("Weiterleitung ohne gültige Zieladresse.")?;
            url = url
                .join(location)
                .map_err(|_| "Ungültige CalDAV-Weiterleitung.")?;
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                return Err("Unsichere CalDAV-Weiterleitung wurde abgelehnt.".into());
            }
            continue;
        }
        if response.status() == 401 || response.status() == 403 {
            return Ok("Der HTTPS-Endpunkt verlangt eine Anmeldung. CalDAV-Unterstützung ist damit noch nicht bestätigt. Authentifizierte Kalendersynchronisation folgt.".into());
        }
        if response.status().as_u16() != 207 {
            return Err(format!("Keine CalDAV-Antwort (HTTP {}). Bitte den Kalender-Endpunkt beim Anbieter erfragen.", response.status().as_u16()));
        }
        let mut xml = String::new();
        response
            .take(512 * 1024)
            .read_to_string(&mut xml)
            .map_err(|_| "CalDAV-Antwort konnte nicht gelesen werden.")?;
        let doc = roxmltree::Document::parse(&xml)
            .map_err(|_| "CalDAV-Endpunkt liefert kein gültiges XML.")?;
        let supported = doc
            .descendants()
            .filter(|n| n.has_tag_name(("DAV:", "propstat")))
            .any(|propstat| {
                propstat.children().any(|n| {
                    n.has_tag_name(("DAV:", "status"))
                        && n.text()
                            .is_some_and(|s| s.split_whitespace().nth(1) == Some("200"))
                }) && propstat.descendants().any(|n| {
                    n.tag_name().namespace() == Some("urn:ietf:params:xml:ns:caldav")
                        && ["calendar", "calendar-home-set"].contains(&n.tag_name().name())
                })
            });
        return Ok(if supported { "CalDAV-Eigenschaften erkannt. Die Adresse kann gespeichert werden; Kalendersynchronisation folgt." } else { "WebDAV-Endpunkt erreichbar. CalDAV konnte ohne Anmeldung noch nicht bestätigt werden." }.into());
    }
    Err("Zu viele CalDAV-Weiterleitungen.".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn account() -> Account {
        Account {
            name: "Test".into(),
            email: "sender@example.org".into(),
            username: "test-user".into(),
            imap_host: "127.0.0.1".into(),
            imap_port: 143,
            imap_security: Security::Starttls,
            smtp_host: "smtp.example.org".into(),
            smtp_port: 587,
            smtp_security: Security::Starttls,
            smtp_username: "test-user".into(),
            caldav_url: String::new(),
            remember_password: false,
        }
    }

    #[test]
    fn starttls_rejection_never_sends_login() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let mut a = account();
        a.imap_port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            stream.write_all(b"* OK test server\r\n").unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(
                line.ends_with(" STARTTLS\r\n"),
                "Unexpected plaintext command"
            );
            assert!(!line.contains("test-secret"));
            let tag = line.split_whitespace().next().unwrap();
            reader
                .get_mut()
                .write_all(format!("{tag} NO TLS unavailable\r\n").as_bytes())
                .unwrap();
            let mut remainder = String::new();
            let _ = reader.read_to_string(&mut remainder);
            assert!(!remainder.contains("LOGIN"));
            assert!(!remainder.contains("test-secret"));
        });
        let c = Credentials {
            account: a,
            password: "test-secret".into(),
            smtp_password: "test-secret".into(),
        };
        assert!(connect(&c).is_err());
        server.join().unwrap();
    }

    #[test]
    fn compose_validates_recipients_and_keeps_text_utf8() {
        let draft = Draft {
            id: new_id(),
            revision: 0,
            sent_folder: None,
            to: "one@example.org, two@example.org".into(),
            subject: "Grüße".into(),
            body: "Hallo Welt".into(),
        };
        let message = build_message(&account(), &draft).unwrap();
        assert_eq!(message.envelope().to().len(), 2);
        let invalid = Draft {
            to: "not an address".into(),
            ..draft
        };
        assert!(build_message(&account(), &invalid).is_err());
    }
    #[test]
    fn mime_decodes_subject_and_ignores_html_and_attachments() {
        let raw = b"From: Anna <anna@example.org>\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=C3=BC=C3=9Fe\r\n--x\r\nContent-Type: text/html\r\n\r\n<script>bad()</script>\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=secret.txt\r\n\r\nnot body\r\n--x--\r\n";
        let mail = parse_header(raw, 1, true, false, raw.len() as u32).unwrap();
        assert_eq!(mail.subject, "Grüße");
        let parsed = mailparse::parse_mail(raw).unwrap();
        let (mut text, mut attachments) = (vec![], vec![]);
        collect_parts(&parsed, &mut text, &mut attachments, 0).unwrap();
        assert_eq!(text, vec!["Grüße"]);
        assert_eq!(attachments, vec!["secret.txt"]);
    }
    #[test]
    fn stale_uidvalidity_and_control_characters_are_rejected() {
        assert!(verify_validity(Some(2), 1, 9).is_err());
        assert!(verify_validity(None, 1, 9).is_err());
        assert!(verify_validity(Some(1), 1, 0).is_err());
        assert!(verify_validity(Some(1), 1, 9).is_ok());
        assert!(validate_folder("INBOX\r\nLOGOUT").is_err());
    }
    #[test]
    fn caldav_rejects_plaintext_and_embedded_passwords_without_network() {
        assert!(probe_caldav("http://localhost/caldav").is_err());
        assert!(probe_caldav("https://user:secret@localhost/caldav").is_err());
    }
}
