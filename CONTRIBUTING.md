# Contributing to email

Everyone is welcome to contribute through GitHub pull requests. Bug reports,
documentation improvements, translations, accessibility work and code changes are
all useful. You do not need repository write access to get started.

## Getting started

1. Fork [KevinKickass/email](https://github.com/KevinKickass/email).
2. Clone your fork and create a branch from `main`:

   ```sh
   git clone https://github.com/YOUR-USERNAME/email.git
   cd email
   git switch -c your-change
   npm ci
   ```

3. Follow the [development instructions](README.md#development). Use `npm run dev`
   for the browser preview or `npm run desktop` for the native application.
4. Make a focused change and run the relevant checks below.
5. Commit, push your branch to your fork, and open a pull request targeting `main`
   in `KevinKickass/email`. Draft pull requests are welcome.

For a larger feature or change in behaviour, opening an issue first can help agree
on the scope. Small fixes and documentation improvements can go straight to a PR.
Describe the problem, the resulting behaviour and how you checked the change.
Screenshots are helpful for visual changes.

## Project direction

email is a classic desktop mail client for Windows x64, Windows x86 and Linux x64.
The stack is Tauri, Rust, React and TypeScript, with redb for local storage.
The mail protocols are IMAP and SMTP; CalDAV support is optional. Keep the
interface familiar, readable and keyboard-accessible. See the
[roadmap](README.md#roadmap-to-production-use) for work still needed.

Keep the README, contributor documentation, issues, PR descriptions and release
notes in English where possible. The app supports German and English. UI text
belongs in the translation system: German source strings are translated through
`t(...)`, with English entries in `src/locales/en.json`. Preserve interpolation
placeholders in both languages and use the selected locale for dates and numbers.
Email content and server-defined folder names must keep their original meaning.

## Checks

Run checks appropriate to the files you changed:

| Change                            | Checks                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| React, TypeScript or translations | `npm test` and `npm run build`                                                                                                                         |
| Rust mail, settings or Tauri code | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` and `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` |
| redb storage                      | `cargo test --locked --manifest-path crates/mail-store/Cargo.toml`                                                                                     |
| Release assembly                  | `python3 -m unittest discover -s scripts`                                                                                                              |
| Documentation only                | Check wording, links and commands; a desktop build is not required                                                                                     |

Use Prettier for frontend files and `cargo fmt --manifest-path src-tauri/Cargo.toml`
for Rust changes. Add focused regression tests when fixing a bug or changing
behaviour. Automated tests should use fixtures or local test servers rather than
real email accounts. CI also builds all three supported desktop targets.

Keep lockfiles in sync when changing dependencies. Version bumps, release tags and
release signing are handled by maintainers; contributors do not need signing keys.
Pull requests build unsigned test packages and do not receive release secrets.

## Email data and updates

Use synthetic messages and example domains in tests and screenshots. Do not commit
passwords, access tokens, private signing keys, personal mail or `email.redb` files.
When reporting a connection problem, include the app version, OS and relevant
error, with account credentials and personal content removed.

Preserve TLS certificate validation, mandatory STARTTLS and draft recovery when
changing protocol code. Automatic update checks and downloads must stay opt-in;
installation must not discard an open message. See the existing regression tests
for these behaviours.

## License

Contributions are accepted under the project's [Apache-2.0 license](LICENSE).
Only contribute code or assets you have the right to submit, and retain required
attribution and license notices for third-party material.
