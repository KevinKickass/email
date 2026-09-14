# email

A classic desktop email client with a ribbon, folder tree, message list and reading
pane. An original interface inspired by familiar Outlook 2010-era workflows, with
German and English language support.

**Version 0.1.2 — technical preview.** This is not yet a production-ready replacement
for customer deployments. The browser preview uses clearly labelled sample data;
real email connections are available in the Tauri desktop app.

[Download releases](https://github.com/KevinKickass/email/releases) ·
[Builds](https://github.com/KevinKickass/email/actions) ·
[Contributing](CONTRIBUTING.md) ·
[Apache-2.0 license](LICENSE)

## Stack

- Tauri 2, Rust, React and TypeScript. All UI assets are embedded.
- IMAP with `imap`, MIME with `mailparse`, SMTP with `lettre`.
- **redb 4.2** for account settings, app preferences, local drafts and message caches.
- OS credential storage through `keyring`: Windows Credential Manager or Linux
  Secret Service. Passwords are not stored in redb.
- Optional CalDAV endpoint probing over HTTPS. No application backend service,
  ActiveSync or Exchange integration is required.

## Development

Install Node.js 22, Rust >= 1.90 and the
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).
Linux requires WebKitGTK 4.1, GTK 3, OpenSSL and D-Bus development packages.

```sh
npm ci
npm run desktop
```

To preview the interface in a browser:

```sh
npm run dev
```

The browser preview runs at `http://127.0.0.1:1420`. Stop an existing Vite server
before running `npm run desktop`; Tauri starts its own development server.

## Implemented features

- Classic ribbon, folder navigation, optional reading pane and compact message list.
- Search loaded senders, recipients and subjects; filter unread or flagged messages.
  `F5` refreshes the folder; `Ctrl+N` opens a draft.
- Manual setup of one account using IMAP and SMTP with TLS or mandatory STARTTLS.
  Both logins are tested before saving, without sending a test message. Separate
  SMTP credentials are supported.
- Fetch server folders and the latest 100 message headers per folder; open messages
  up to 10 MiB. `EXAMINE` and `BODY.PEEK` avoid changing server-side read flags when
  displaying a message. Read/unread and follow-up flags can be changed explicitly.
- Decode MIME character sets and encoded subjects; display plain text and list
  attachment filenames. External images and active content are not loaded.
- Compose, reply and forward plain-text email over SMTP.
- One local draft per account, saved manually, when closing the compose window and
  before sending. Failed sends retain the draft.
- Cache received lists and previously opened message bodies. If a later refresh
  fails during the session, cached messages appear with an offline indicator and
  the actual error.
- Month calendar preview. Save a CalDAV URL and probe its endpoint without
  credentials; limit HTTPS redirects and reject HTTP downgrades. Calendar
  synchronisation is not implemented yet.
- German and English UI, saved language selection, and opt-in signed updates.

## Local data

`email.redb` is stored in Tauri's `app_data_dir` for `de.email.desktop`, usually:

- Windows: `%APPDATA%\de.email.desktop\email.redb`
- Linux: `$XDG_DATA_HOME/de.email.desktop/email.redb`, or
  `~/.local/share/de.email.desktop/email.redb` when `XDG_DATA_HOME` is unset.

The database uses a versioned table with JSON-encoded values inside redb. There are
no separate JSON data files or SQLite dependencies. Message keys include the
server, port, username, folder, UIDVALIDITY and UID. The redb page cache is set to
16 MiB; this is not a limit on the app's total memory use. Writes use redb's default
durable commit semantics.

The database contains personal email data and currently has no additional
encryption. Close the app before copying the database for backup. Live backup
export is not implemented. The database is opened once per process.

Saving passwords stores new credentials in the OS keyring. When disabled, entered
passwords apply to the current session only; previously saved passwords remain in
the keyring. Linux can run without an active Secret Service when passwords are
entered for the session.

The storage layer lives in `crates/mail-store` and can be tested without Tauri.
[redb](https://docs.rs/redb/latest/redb/) provides transactions and crash recovery;
SQL queries and full-text search will require separate indexing or search logic.

## Platforms and packages

| Target      | Download       | Requirements                           |
| ----------- | -------------- | -------------------------------------- |
| Windows x64 | NSIS setup EXE | WebView2                               |
| Windows x86 | NSIS setup EXE | 32-bit-compatible Windows and WebView2 |
| Linux x64   | AppImage       | Compatible Linux desktop environment   |

The executable is separate from the local profile data. The Windows installer can
install WebView2 if it is missing. A loose executable does not install it itself.
See [Windows packaging](https://v2.tauri.app/distribute/windows-installer/).

Since 0.1.1, Linux automatically sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` before
starting GTK/WebKit when the NVIDIA kernel module is loaded. This addresses the
GBM crash and blank window reproduced on Fedora/KDE Wayland. An explicit value
already set by the user is respected.

CI builds Linux packages on Ubuntu 22.04 for compatibility. AppImages built locally
on a newer distribution may require newer system libraries. See the
[AppImage guide](https://v2.tauri.app/distribute/appimage/).

For local **unsigned test builds**:

```sh
# Linux
NO_STRIP=1 npm run tauri -- build --bundles appimage --config '{"bundle":{"createUpdaterArtifacts":false}}'

# Windows (Git Bash)
rustup target add x86_64-pc-windows-msvc i686-pc-windows-msvc
npm run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'
npm run tauri -- build --target i686-pc-windows-msvc --bundles nsis --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

`NO_STRIP=1` bypasses linuxdeploy's older strip tool, which can reject modern ELF
`.relr.dyn` sections. The Rust release profile already strips the application.
To bundle an already built application again, use `tauri bundle` with the same
bundle and signing configuration.

## Language and updates

**Settings** offers Deutsch, English and automatic system-language detection.
Other system languages fall back to English. The selected language and update
preference are saved in redb independently of email accounts. Email content and
server-defined folder names remain in their original language.

Automatic updates are **off by default**. With the option disabled, the app makes
no automatic GitHub requests. When enabled, it checks the latest GitHub Release
15 seconds after startup and every six hours, then downloads an available update.
Choose **Install and restart** to install it when no message is open and no email
operation is running. Manual update checks are also available. Tauri verifies the
update signature before installation.

On Windows, install the app using the matching NSIS setup EXE. On Linux, keep the
AppImage in a writable location; the updater replaces that file. Interrupted
downloads install nothing. Downloads already in progress may finish after the
option is disabled, but installation always requires choosing a restart.

## Publishing releases

`.github/workflows/build.yml` builds and tests all three targets. Pushes to `main`
and pull requests produce unsigned CI test packages. Stable version tags produce
signed packages. A release is published only after all three builds succeed,
including `latest.json`, detached signatures and SHA256 checksums.

1. Bump the version in `package.json`/`package-lock.json`,
   `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`/`Cargo.lock`.
2. Write English release notes in `releases/vX.Y.Z.md`, commit and push.
3. Run `git tag vX.Y.Z` and `git push origin vX.Y.Z`.

The GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` holds the private updater
key. The public key is embedded in `tauri.conf.json`. Back up the private key
securely outside the repository: future updates for existing installations need
the same key. No GitHub token is distributed with the app. The public update feed
is hosted in [GitHub Releases](https://github.com/KevinKickass/email/releases).

For a local signed build, set `TAURI_SIGNING_PRIVATE_KEY` to the key file path or
its contents, optionally set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and omit the
unsigned-build configuration override. Update signatures are separate from
Windows Authenticode code signing.

Keep the README, repository metadata, workflow descriptions and release notes in
English. The application itself supports both German and English.

## Tests

```sh
npm test
npm run build
python3 -m unittest discover -s scripts
cargo test --locked --manifest-path crates/mail-store/Cargo.toml
cargo check --locked --manifest-path crates/mail-store/Cargo.toml --target i686-pc-windows-msvc
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
```

Tests cover persistence, rollback, UID isolation, MIME decoding, recipient
validation, unsafe CalDAV URLs, language selection, update opt-in and release
manifest assembly. The STARTTLS test uses a local test server and verifies that a
rejected TLS upgrade never sends credentials. No real email account is required.
Provider integration and Windows GUI behaviour still need separate testing.

## Roadmap to production use

1. Complete incremental IMAP synchronisation, folder subscriptions, IDLE, offline
   startup, cache cleanup and reconnection.
2. Multiple accounts and drafts, autosave and recovery after an app crash.
3. Reliable IMAP APPEND copies after SMTP delivery and an outbox that handles
   uncertain delivery confirmations. **Sent copies are not saved yet.**
4. Attachment downloads and sending, safe HTML rendering and fuller address handling.
5. Server-side moves/deletes, Modified UTF-7 folder names and SPECIAL-USE folder roles.
   Moving and deleting messages currently work only in the demo.
6. CalDAV discovery, authentication, calendar listing, synchronisation, recurrence,
   time zones and reminders. An IMAP host does not automatically provide CalDAV.
   See [RFC 6764](https://www.rfc-editor.org/rfc/rfc6764).
7. Search indexes for large mailboxes, backup/restore, migrations, platform code
   signing and testing across supported Windows and Linux versions.

The current `imap-proto` dependency emits a Rust future-incompatibility warning.
Update or replace the IMAP library before production release and test protocol
behaviour against Dovecot and other supported servers.

## Contributing

Everyone is welcome to contribute through pull requests. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, the fork/PR workflow and relevant
checks. Bug reports, translations, documentation and code contributions are welcome.

## License

[Apache License 2.0](LICENSE). SPDX identifier: `Apache-2.0`.
Dependencies retain their respective licenses.
