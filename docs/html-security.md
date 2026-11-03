# HTML reading and privacy

email displays a conservative HTML subset. The goal is readable mail with no
automatic sender-controlled requests or executable content inside the application.

## Boundaries

1. MIME decoding and HTML parsing happen in Rust. Raw HTML is never parsed in the
   application WebView. `multipart/alternative` keeps the last supported HTML
   alternative and the original plain-text alternative. Related parts use their
   designated root; ordinary mixed text sections remain in order. HTML attachments
   remain attachments and are never treated as the message body.
2. [Ammonia](https://docs.rs/ammonia/latest/ammonia/) sanitises the HTML using an
   explicit tag and attribute allowlist. Scripts, forms, frames, objects, SVG,
   MathML, style sheets, source URLs, IDs, classes and event handlers are removed.
   A small set of non-fetching inline properties preserves basic colours,
   emphasis and alignment. CSS functions, escapes, positioning, sizes, imports,
   custom properties and external fonts are excluded.
3. `MessageBody` accepts body format 2 and places it in an iframe with
   `sandbox="allow-same-origin"` and `referrerpolicy="no-referrer"`. Scripts, forms,
   popups and top-level navigation remain disabled. Same-origin access lets trusted
   parent code attach click handlers and insert approved images; **allow-scripts is
   never granted**. A static CSP precedes the content: scripts, connections, frames,
   fonts and media are forbidden; only inline styles and raster data images are used.
   The application CSP still permits only local frames and data/local images.
4. Link labels and positions survive sanitisation as inert `data-mail-link` indices.
   Source-provided data attributes are discarded. The trusted parent assigns link
   semantics, keyboard focus and click/Enter handlers, without a navigable `href`.
   Hover/focus shows the actual HTTP/HTTPS destination. Explicit activation calls a
   Rust command which validates it again before opening the default browser. Up to
   100 distinct URLs are supported. Credentials, controls, other schemes and URLs
   over 2,048 bytes are rejected. The opener plugin's automatic link handling stays
   disabled. Links are inactive in the sample mailbox.
5. Remote image URLs and legacy table/cell backgrounds become inert indices into a
   separate, bounded list. A banner explains that loading them may reveal that the
   message was opened. Only **Load images** starts the native request, bound to the
   active account, folder, UIDVALIDITY and UID of a cached message. IPC accepts image
   indices, never arbitrary fetch URLs. Successes are shown; failures can be retried
   without re-fetching successful images. **Block images again** removes them.
   Navigating to another message discards consent and ignores late results.
6. The native loader validates HTTP/HTTPS URLs and every redirect, restricts ports
   to 80/443, rejects private/local/reserved IPs, and pins checked DNS addresses for
   the request. HTTPS cannot redirect to HTTP. No proxy, browser cookies,
   authentication or referrer is forwarded. Redirects, request duration, image count
   (50), each image (5 MiB) and total successful payload (20 MiB) are bounded.
   Only PNG, JPEG, GIF and WebP signatures become raster data URLs. SVG, HTML and
   other active content are rejected even if a server labels them as an image.
   Downloaded image bytes live in the current reader; they are not persisted.

Sender scripts, forms, frames, external stylesheets/fonts, CSS URLs and inline/CID
images are not enabled by the image button. MIME image attachments can still be
saved through the attachment workflow. The browser preview does not fetch remote
images.

## Text fallback and caches

The reader offers HTML and Plain text. If the sender supplied no usable plain-text
alternative, `html2text` derives one from the sanitised content and appends the
allowed link destinations. Replies and forwards use text, not raw HTML or an
injected placeholder. Broken HTML transfer encoding, excessive HTML size or
complexity falls back to plain text when available and displays an explanation.

HTML input is limited to 2 MiB, 10,000 markup delimiters, 20,000 parsed nodes and
128 levels of nesting. Table spans are bounded. These are additional to the MIME
and attachment limits; this is not a streaming HTML renderer. Presentation may
differ from the sender's original layout.

Full MIME caches from 0.3.0 upgrade locally, without credentials or network access.
Headers, explicit read/flag changes and the original MIME bytes are retained.
Older caches without MIME need an online fetch for HTML; their cached text stays
readable offline. Sanitised body records are versioned. Changes to the sanitising
policy must update both the Rust body version and the frontend's accepted version
so cached content is reprocessed before it is displayed.

The redb database contains personal mail data and has no additional encryption.
Sanitisation does not authenticate the sender or make linked websites trustworthy.

## Verification

```sh
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --lib -- -D warnings
```

Tests cover hostile/obfuscated HTML, network-bearing attributes, unsafe schemes,
CSS filtering, MIME alternatives and charsets, HTML-only quoting, broken transfer
encoding, mixed/related messages, size limits and offline cache upgrades. UI tests
check the sandbox and CSP, text switching, explicit link opening and reply/forward
content. `npm run preview` serves the production UI with the desktop CSP.

For a browser privacy regression check, run from the repository root:

```sh
node scripts/html-smoke.mjs
```

Open `http://127.0.0.1:4174`. The script runs the actual Rust sanitizer on the fixture
and uses the production document wrapper. Both the sanitised mail and an
unsanitised control must remain readable, both frame checks must report script blocking with parent handlers available,
and the parent sentinel must remain unchanged. Clicking the link in the sanitised
frame must report its real destination without navigating the frame. Do not follow links
in the raw control. `http://127.0.0.1:4174/status` must report `{"probes":0}`.
Stop the server with Ctrl+C. The fixture's resource probes target only this server.

The regression check exercises both a sanitised message and a hostile raw control. CI runs the
Rust and UI tests on Windows x64, Windows x86 and Linux x64. Native WebView2 and
WebKitGTK GUI behaviour and real-provider integration need additional manual tests;
a browser check is not a substitute for those platform tests.
