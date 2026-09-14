# email

Ein klassischer Desktop-Mailclient mit deutscher und englischer Oberfläche: Menüband, Ordnerbaum,
Nachrichtenliste und Lesebereich. Eigenständiges Design mit vertrauter Bedienung
aus der Outlook-2010-Zeit.

**Stand: 0.1.1, technischer Prototyp.** Noch kein fertiger Ersatz für den produktiven
Kundeneinsatz. Die Browseransicht enthält ausschließlich gekennzeichnete Beispieldaten;
echte Serververbindungen gibt es in der Tauri-Desktop-App.

## Stack

- Tauri 2, Rust, React und TypeScript; alle UI-Dateien werden eingebettet.
- IMAP mit `imap`, MIME mit `mailparse`, SMTP mit `lettre`.
- **redb 4.2** für Kontoeinstellungen, lokale Entwürfe und Nachrichtencache.
- Betriebssystem-Schlüsselspeicher über `keyring`: Windows Credential Manager bzw.
  Secret Service unter Linux. Kennwörter werden nicht in redb gespeichert.
- Optionaler CalDAV-Endpunkt über HTTPS. Kein eigener Backendserver erforderlich.

## Starten

Voraussetzungen: Node.js 22, Rust >= 1.90 und die
[Tauri-Systemabhängigkeiten](https://v2.tauri.app/start/prerequisites/).
Unter Linux insbesondere WebKitGTK 4.1, GTK 3, OpenSSL und D-Bus-Entwicklungspakete.

```sh
npm ci
npm run desktop
```

Nur die Oberfläche im Browser ausprobieren:

```sh
npm run dev
```

Die Vorschau läuft auf `http://127.0.0.1:1420`. Vor `npm run desktop` einen bereits
laufenden Vite-Server beenden, da Tauri diesen selbst startet.

## Bereits umgesetzt

- Klassisches Menüband, Ordnernavigation, Lesebereich ein-/ausblenden, kompakte Liste.
- Suche in den geladenen Absendern, Empfängern und Betreffzeilen; Filter für ungelesene
  und markierte Nachrichten. `F5` aktualisiert, `Strg+N` öffnet einen Entwurf.
- Ein Konto manuell einrichten; IMAP und SMTP mit TLS oder obligatorischem STARTTLS.
  Beide Anmeldungen werden vor dem Speichern geprüft, ohne Testnachricht zu senden.
- Unterschiedliche SMTP-Zugangsdaten sind möglich.
- Serverordner abrufen, die letzten 100 Nachrichtenköpfe pro Ordner lesen, einzelne
  Nachrichten bis 10 MiB öffnen. Der Abruf verwendet `EXAMINE` und `BODY.PEEK`,
  verändert also beim Lesen keine serverseitigen Gelesen-Markierungen.
- Gelesen/Ungelesen und Nachverfolgung ausdrücklich auf dem Server setzen.
- MIME-Zeichensätze und kodierte Betreffzeilen dekodieren; Nur-Text-Darstellung;
  Anhänge als Dateinamen auflisten. Aktive Inhalte und externe Bilder bleiben gesperrt.
- Textnachrichten über SMTP schreiben, beantworten und weiterleiten.
- Ein lokaler Entwurf pro Konto: manuell speichern, beim Schließen des Nachrichtenfensters
  sichern und vor jedem Versand speichern. Fehlgeschlagener Versand behält den Entwurf.
- Empfangene Listen und bereits geöffnete Texte lokal speichern. Schlägt eine spätere
  Aktualisierung innerhalb der Sitzung fehl, erscheint der gespeicherte Stand mit
  Offline-Kennzeichnung und der tatsächlichen Fehlermeldung.
- Monatskalender als Layoutvorschau. CalDAV-URL speichern und Endpunkt ohne Zugangsdaten
  prüfen; HTTPS-Weiterleitungen werden begrenzt und HTTP-Downgrades abgelehnt.

## Lokale Daten

`email.redb` liegt in Tauri `app_data_dir` für `de.email.desktop`, üblicherweise:

- Windows: `%APPDATA%\de.email.desktop\email.redb`
- Linux: `$XDG_DATA_HOME/de.email.desktop/email.redb`, sonst
  `~/.local/share/de.email.desktop/email.redb`

Die Datenbank verwendet eine versionierte Tabelle. Werte werden als JSON-Bytes innerhalb
von redb gespeichert; es gibt keine losen JSON-Dateien und keine SQLite-Abhängigkeit.
Nachrichtenschlüssel enthalten Server, Port, Benutzer, Ordner, UIDVALIDITY und UID.
Der redb-Seitencache ist auf 16 MiB konfiguriert; das ist kein Gesamt-RAM-Limit der App.
Schreibtransaktionen verwenden die standardmäßige dauerhafte Commit-Semantik.

Die Datenbank enthält persönliche Maildaten und ist derzeit nicht zusätzlich verschlüsselt.
Für eine einfache Dateisicherung die Anwendung vorher schließen. Ein Live-Backup-Export
ist noch nicht eingebaut. Die Datenbank wird einmal pro Prozess geöffnet.

„Kennwort merken“ speichert neue Kennwörter im Systemschlüsselspeicher. Ohne diese Option
gelten eingegebene Kennwörter nur für die Sitzung; schon früher gespeicherte Kennwörter
werden dadurch nicht gelöscht. Linux kann ohne laufenden Secret Service mit eingegebenen
Sitzungskennwörtern verwendet werden.

Die redb-Schicht liegt separat in `crates/mail-store` und ist ohne Tauri testbar. redb
passt zur eingebetteten Rust-Anwendung und bietet Transaktionen und Crash-Recovery.
Es bringt keine SQL-Abfragen oder Volltextsuche mit; dafür werden später eigene Indizes
bzw. eine zusätzliche Suchkomponente benötigt. Siehe [redb](https://docs.rs/redb/latest/redb/).

## Plattformen und Pakete

Ab 0.1.1 aktiviert die Linux-App bei geladenem NVIDIA-Treiber vor dem Start von
GTK/WebKit automatisch `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Das behebt den hier
reproduzierten GBM-Absturz bzw. das weiße Fenster unter Fedora/KDE Wayland.
Eine bereits gesetzte Umgebungsvariable wird respektiert. Andere Grafiktreiber
und die Windows-Ausgaben behalten ihre bisherigen Einstellungen.

| Ziel        | Ausgabe        | Voraussetzung                    |
| ----------- | -------------- | -------------------------------- |
| Windows x64 | NSIS-Setup-EXE | WebView2                         |
| Windows x86 | NSIS-Setup-EXE | 32-Bit-Ziel und WebView2         |
| Linux x64   | AppImage       | kompatibles Linux-Desktop-System |

Die ausführbare Datei ist von der wachsenden lokalen Profildatei getrennt. Windows
nutzt die installierte WebView2-Laufzeit; der NSIS-Installer kann diese nachinstallieren.
Eine lose EXE erledigt diese Installation nicht selbst.
[Windows-Paketierung](https://v2.tauri.app/distribute/windows-installer/)

Für breite Linux-Kompatibilität auf dem ältesten unterstützten System bauen. Die CI
verwendet Ubuntu 22.04; ein auf einem neueren lokalen Linux erzeugtes AppImage kann
neuere Systembibliotheken voraussetzen.
[AppImage-Hinweise](https://v2.tauri.app/distribute/appimage/)

```sh
# Linux
NO_STRIP=1 npm run tauri -- build --bundles appimage

# Auf Windows x64
rustup target add x86_64-pc-windows-msvc i686-pc-windows-msvc
npm run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis
npm run tauri -- build --target i686-pc-windows-msvc --bundles nsis
```

`NO_STRIP=1` umgeht das ältere Strip-Werkzeug in linuxdeploy, das auf neueren
Distributionen an `.relr.dyn`-Abschnitten scheitern kann. Rust entfernt die
Debugsymbole der Anwendung bereits im Release-Profil.
Die Paketierung einer schon gebauten Anwendung kann mit
`NO_STRIP=1 npm run tauri -- bundle --bundles appimage` wiederholt werden.

`.github/workflows/build.yml` baut und testet Windows x64, Windows x86 und Linux x64.
Pushes auf `main` und Pull Requests erzeugen unsignierte CI-Testpakete. Ein stabiles
Tag wie `v0.1.1` erzeugt signierte EXE-/AppImage-Pakete und veröffentlicht erst nach
Erfolg aller drei Builds ein GitHub Release samt `latest.json`, Signaturen und SHA256-Prüfsummen.

## Sprache und Updates

Unter **Einstellungen** stehen Deutsch, English und automatische Systemerkennung
zur Auswahl (andere Systemsprachen verwenden Englisch). Die Auswahl und der
Update-Schalter werden kontounabhängig in redb gespeichert. E-Mail-Inhalte und
vom Server vergebene Ordnernamen bleiben in ihrer Originalsprache.

Automatische Updates sind **standardmäßig ausgeschaltet**: ohne Aktivierung
keine automatischen GitHub-Anfragen. Aktiviert prüft email 15 Sekunden nach dem
Start und alle sechs Stunden das neueste Release und lädt ein verfügbares Update.
Die Installation erfolgt über **Installieren und neu starten**, wenn keine Nachricht
offen ist und kein Mail-Vorgang läuft. Eine manuelle Prüfung ist jederzeit möglich.
Das Tauri-Updater-Plugin prüft die Signatur vor der Installation.

Windows-Updates setzen eine Installation über die passende NSIS-Setup-EXE voraus.
Unter Linux das AppImage an einen beschreibbaren Ort legen; die Datei wird beim
Update ersetzt. Ein unterbrochener Download installiert nichts. Bereits laufende
Downloads können nach Ausschalten des Schalters noch abgeschlossen werden;
eine automatische Installation findet nicht statt.

## Ein Release veröffentlichen

1. Version in `package.json`/`package-lock.json`, `src-tauri/tauri.conf.json` und
   `src-tauri/Cargo.toml`/`Cargo.lock` erhöhen.
2. Versionshinweise unter `releases/vX.Y.Z.md` anlegen, committen und pushen.
3. `git tag vX.Y.Z` und `git push origin vX.Y.Z` ausführen.

Das GitHub-Actions-Secret `TAURI_SIGNING_PRIVATE_KEY` enthält den privaten
Updater-Schlüssel. Der öffentliche Schlüssel steht in `tauri.conf.json`.
Den privaten Schlüssel sicher außerhalb des Repositories sichern: er wird für
alle künftigen Updates bestehender Installationen benötigt. Kein GitHub-Token
wird an Nutzer ausgeliefert; das Update-Manifest liegt im öffentlichen Repository
[KevinKickass/email](https://github.com/KevinKickass/email/releases).

Lokale signierte Builds benötigen `TAURI_SIGNING_PRIVATE_KEY` (Dateipfad oder Inhalt)
und bei Bedarf `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Für einen unsignierten Testbuild
zusätzlich `--config '{"bundle":{"createUpdaterArtifacts":false}}'` an `tauri build`
übergeben. Update-Signaturen sind keine Windows-Authenticode-Signatur.

## Lizenz

Apache License 2.0, siehe [LICENSE](LICENSE). SPDX: `Apache-2.0`.
Abhängigkeiten behalten ihre jeweiligen Lizenzen.

## Prüfen

```sh
npm test
npm run build
cargo test --locked --manifest-path crates/mail-store/Cargo.toml
cargo check --locked --manifest-path crates/mail-store/Cargo.toml --target i686-pc-windows-msvc
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
```

Der STARTTLS-Test verwendet einen lokalen Testserver. Die übrigen Regressionstests
prüfen Persistenz, Rollback, UID-Isolation, MIME-Dekodierung, Empfängerprüfung und
unsichere CalDAV-Adressen. Sie benötigen kein reales E-Mail-Konto. Echte Provider-
Integration und Laufzeitverhalten auf Windows sind noch separat zu testen.

## Nächste Schritte zum Kundenprodukt

1. Vollständige, inkrementelle IMAP-Synchronisation, Ordnerabonnements und IDLE;
   vollständiger Offlinestart, Cachebereinigung und Wiederverbindung.
2. Mehrere Konten und Entwürfe; Autosave und Wiederherstellung nach App-Abbruch.
3. SMTP-Versand mit verlässlicher Gesendet-Kopie per IMAP APPEND; Postausgang mit
   Behandlung unklarer Versandbestätigungen. **Aktuell wird keine Gesendet-Kopie abgelegt.**
4. Anhänge herunterladen/versenden, sichere HTML-Ansicht und vollständige Adressverarbeitung.
5. Serverseitiges Verschieben/Löschen, deutsche Ordnernamen inklusive Modified UTF-7,
   Ordnerrollen anhand SPECIAL-USE. Verschieben/Löschen sind derzeit nur Demoaktionen.
6. CalDAV-Discovery (SRV/TXT und Well-Known), Anmeldung, Kalenderauflistung, echte
   Synchronisation, Serien, Zeitzonen und Erinnerungen. Der IMAP-Server stellt nicht
   automatisch CalDAV bereit. [Discovery-Standard](https://www.rfc-editor.org/rfc/rfc6764)
7. Suchindizes für große Postfächer, Backup/Restore, Migrationen, Signierung und Tests
   auf den unterstützten Windows-/Linux-Versionen.

Die aktuell verwendete `imap-proto`-Version meldet eine Rust-Future-Incompatibility-Warnung.
Vor der Produktfreigabe die IMAP-Bibliothek aktualisieren oder austauschen und den
Protokollumfang mit Dovecot/anderen Zielservern prüfen.
