use crate::{mail, Result};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use std::io::{Read, Write};

// Keep the wire name intact. Only labels are decoded from IMAP modified UTF-7.
pub fn decode_name(name: &str) -> String {
    fn decode(name: &str) -> Option<String> {
        let mut result = String::new();
        let mut rest = name;
        while let Some(start) = rest.find('&') {
            result.push_str(&rest[..start]);
            rest = &rest[start + 1..];
            let end = rest.find('-')?;
            if end == 0 {
                result.push('&');
            } else {
                let bytes = STANDARD_NO_PAD.decode(rest[..end].replace(',', "/")).ok()?;
                if bytes.len() % 2 != 0 {
                    return None;
                }
                let words: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|b| u16::from_be_bytes([b[0], b[1]]))
                    .collect();
                result.push_str(&String::from_utf16(&words).ok()?);
            }
            rest = &rest[end + 1..];
        }
        result.push_str(rest);
        Some(result)
    }
    decode(name).unwrap_or_else(|| name.into())
}

pub fn role(name: &str, attributes: &[imap::types::NameAttribute<'_>]) -> Option<String> {
    if name.eq_ignore_ascii_case("INBOX") {
        return Some("inbox".into());
    }
    for attr in attributes {
        if let imap::types::NameAttribute::Custom(value) = attr {
            let flag = value.trim_start_matches('\\').to_ascii_lowercase();
            if ["sent", "drafts", "trash", "archive", "junk"].contains(&flag.as_str()) {
                return Some(flag);
            }
        }
    }
    // Common names are a fallback, never used as a protocol path.
    let decoded = decode_name(name).to_lowercase();
    let leaf = decoded.rsplit(['/', '.']).next().unwrap_or(&decoded);
    Some(
        match leaf {
            "sent" | "sent items" | "sent messages" | "gesendet" | "gesendete elemente" => "sent",
            "drafts" | "entwürfe" => "drafts",
            "trash"
            | "deleted items"
            | "deleted messages"
            | "papierkorb"
            | "gelöscht"
            | "gelöschte elemente" => "trash",
            "archive" | "archives" | "archiv" => "archive",
            "junk" | "spam" | "junk e-mail" => "junk",
            _ => return None,
        }
        .into(),
    )
}

pub fn quoted_inner(name: &str) -> Result<String> {
    mail::validate_folder(name)?;
    Ok(name.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn move_on<T: Read + Write>(
    session: &mut imap::Session<T>,
    source: &str,
    target: &str,
    uid: u32,
    validity: u32,
) -> Result<()> {
    mail::validate_folder(source)?;
    let quoted_target = format!("\"{}\"", quoted_inner(target)?);
    if source == target {
        return Err("Quell- und Zielordner sind identisch.".into());
    }
    let caps = session
        .capabilities()
        .map_err(|_| "IMAP-Funktionen konnten nicht geprüft werden.")?;
    let (can_move, uidplus) = (caps.has_str("MOVE"), caps.has_str("UIDPLUS"));
    if !can_move && !uidplus {
        return Err(
            "Dieser Server unterstützt kein sicheres Verschieben (MOVE oder UIDPLUS erforderlich)."
                .into(),
        );
    }
    let mailbox = session
        .select(source)
        .map_err(|_| "Quellordner konnte nicht geöffnet werden.")?;
    mail::verify_validity(mailbox.uid_validity, validity, uid)?;
    let uid = uid.to_string();
    let fail = || {
        "Verschieben nicht bestätigt. Beide Ordner aktualisieren und vor einem erneuten Versuch prüfen; eine Kopie kann bereits vorhanden sein.".to_string()
    };
    if can_move {
        session.uid_mv(&uid, target).map_err(|_| fail())?;
    } else {
        // imap 2.4's COPY accepts raw arguments; unlike MOVE it does not quote the mailbox.
        session.uid_copy(&uid, quoted_target).map_err(|_| fail())?;
        session
            .uid_store(&uid, "+FLAGS.SILENT (\\Deleted)")
            .map_err(|_| fail())?;
        // Never EXPUNGE the whole mailbox, which could delete another client's messages.
        session.uid_expunge(&uid).map_err(|_| fail())?;
    }
    Ok(())
}

pub fn append_on<T: Read + Write>(
    session: &mut imap::Session<T>,
    target: &str,
    id: &str,
    raw: &[u8],
) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(|_| "Ungültige Nachrichten-ID.")?;
    let escaped = quoted_inner(target)?;
    session
        .examine(target)
        .map_err(|_| "Gesendet-Ordner konnte nicht geöffnet werden.")?;
    let found = session
        .uid_search(format!("HEADER Message-ID \"<{id}@email.local>\""))
        .map_err(|_| "Gesendet-Kopie konnte nicht geprüft werden.")?;
    if found.is_empty() {
        // APPEND wraps the name in quotes itself but does not escape its contents.
        session
            .append_with_flags(escaped, raw, &[imap::types::Flag::Seen])
            .map_err(|_| {
                "Gesendet-Kopie nicht bestätigt. Sie kann später erneut geprüft werden.".to_string()
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modified_utf7_preserves_wire_names_and_handles_invalid_input() {
        assert_eq!(decode_name("Entw&APw-rfe"), "Entwürfe");
        assert_eq!(decode_name("A &- B"), "A & B");
        assert_eq!(decode_name("&broken"), "&broken");
        assert_eq!(quoted_inner("a\"b\\c").unwrap(), "a\\\"b\\\\c");
        assert!(quoted_inner("x\r\nLOGOUT").is_err());
    }

    fn fixture(
        steps: Vec<(String, String)>,
    ) -> (
        imap::Session<std::net::TcpStream>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut commands = vec![("LOGIN \"user\" \"pass\"".into(), String::new())];
            commands.extend(steps);
            for (expected, response) in commands {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let (tag, command) = line.trim_end().split_once(' ').unwrap();
                assert_eq!(command, expected);
                reader
                    .get_mut()
                    .write_all(format!("{response}{tag} OK done\r\n").as_bytes())
                    .unwrap();
            }
            let mut extra = String::new();
            reader.read_to_string(&mut extra).unwrap();
            assert!(extra.is_empty(), "unexpected extra commands: {extra}");
        });
        let stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let session = imap::Client::new(stream).login("user", "pass").unwrap();
        (session, server)
    }
    #[test]
    fn uidplus_move_quotes_mailbox_and_expunge_only_the_selected_uid() {
        let (mut session, server) = fixture(vec![
            (
                "CAPABILITY".into(),
                "* CAPABILITY IMAP4rev1 UIDPLUS\r\n".into(),
            ),
            (
                "SELECT \"INBOX\"".into(),
                "* OK [UIDVALIDITY 4] stable\r\n".into(),
            ),
            (
                "UID COPY 9 \"Archive \\\"2026\\\"\\\\saved\"".into(),
                "".into(),
            ),
            ("UID STORE 9 +FLAGS.SILENT (\\Deleted)".into(), "".into()),
            ("UID EXPUNGE 9".into(), "* 1 EXPUNGE\r\n".into()),
        ]);
        move_on(&mut session, "INBOX", "Archive \"2026\"\\saved", 9, 4).unwrap();
        drop(session);
        server.join().unwrap();
    }
    #[test]
    fn move_capability_uses_single_uid_move_and_stale_validity_never_mutates() {
        for validity in [4, 5] {
            let mut steps = vec![
                (
                    "CAPABILITY".into(),
                    "* CAPABILITY IMAP4rev1 MOVE\r\n".into(),
                ),
                (
                    "SELECT \"INBOX\"".into(),
                    "* OK [UIDVALIDITY 4] stable\r\n".into(),
                ),
            ];
            if validity == 4 {
                steps.push(("UID MOVE 9 \"Trash\"".into(), "".into()));
            }
            let (mut session, server) = fixture(steps);
            assert_eq!(
                move_on(&mut session, "INBOX", "Trash", 9, validity).is_ok(),
                validity == 4
            );
            drop(session);
            server.join().unwrap();
        }
    }
    #[test]
    fn no_move_or_uidplus_never_copies_or_deletes() {
        let (mut session, server) = fixture(vec![(
            "CAPABILITY".into(),
            "* CAPABILITY IMAP4rev1\r\n".into(),
        )]);
        assert!(move_on(&mut session, "INBOX", "Trash", 9, 4).is_err());
        drop(session);
        server.join().unwrap();
    }
    #[test]
    fn existing_message_id_prevents_duplicate_append() {
        let id = "7e9a2992-3552-4704-bde0-de4330d6b8e9";
        let (mut session, server) = fixture(vec![
            (
                "EXAMINE \"Sent\"".into(),
                "* OK [UIDVALIDITY 4] stable\r\n".into(),
            ),
            (
                format!("UID SEARCH HEADER Message-ID \"<{id}@email.local>\""),
                "* SEARCH 42\r\n".into(),
            ),
        ]);
        append_on(&mut session, "Sent", id, b"must not be appended").unwrap();
        drop(session);
        server.join().unwrap();
    }
    #[test]
    fn append_escapes_folder_and_writes_exact_mime_literal() {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let raw = b"Subject: Hello\r\n\r\nExact MIME bytes";
        let id = "7e9a2992-3552-4704-bde0-de4330d6b8e9";
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            for (command, response) in [
                ("LOGIN \"user\" \"pass\"".to_string(), ""),
                (
                    "EXAMINE \"Sent \\\"2026\\\"\"".into(),
                    "* OK [UIDVALIDITY 4] stable\r\n",
                ),
                (
                    format!("UID SEARCH HEADER Message-ID \"<{id}@email.local>\""),
                    "* SEARCH\r\n",
                ),
            ] {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let (tag, actual) = line.trim_end().split_once(' ').unwrap();
                assert_eq!(actual, command);
                reader
                    .get_mut()
                    .write_all(format!("{response}{tag} OK done\r\n").as_bytes())
                    .unwrap();
            }
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let (tag, command) = line.trim_end().split_once(' ').unwrap();
            assert_eq!(
                command,
                format!("APPEND \"Sent \\\"2026\\\"\" (\\Seen) {{{}}}", raw.len())
            );
            reader.get_mut().write_all(b"+ continue\r\n").unwrap();
            let mut received = vec![0; raw.len() + 2];
            reader.read_exact(&mut received).unwrap();
            assert_eq!(&received[..raw.len()], raw);
            assert_eq!(&received[raw.len()..], b"\r\n");
            reader
                .get_mut()
                .write_all(format!("{tag} OK appended\r\n").as_bytes())
                .unwrap();
        });
        let stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut session = imap::Client::new(stream).login("user", "pass").unwrap();
        append_on(&mut session, "Sent \"2026\"", id, raw).unwrap();
        drop(session);
        server.join().unwrap();
    }
}
