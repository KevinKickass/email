# HTML reading and privacy

email displays a conservative HTML subset. The goal is readable mail with no
sender-controlled requests or executable content inside the application.

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
3. `MessageBody` accepts only the current body format and places the result in an
   iframe with an empty `sandbox` attribute and `referrerpolicy="no-referrer"`.
   It grants neither scripts nor same-origin access, forms, popups or top-level
   navigation. A static CSP precedes the content: all resources are denied except
   the viewer's inline styles. This is separate from the application CSP, which
   permits only local frames. See the [srcdoc security guidance](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc).
4. Sanitised HTML has no navigable links. Up to 100 distinct absolute HTTP/HTTPS
   destinations are listed outside the iframe. A click on the visible destination
   calls a Rust command which validates it again before opening the default
   browser. URLs with credentials, controls, other schemes or more than 2,048
   bytes are rejected. Host names are canonicalised, including IDN/punycode.
   The opener plugin's automatic JavaScript link handling is explicitly disabled;
   no general frontend filesystem or opener permission is granted. See the
   [Tauri opener](https://v2.tauri.app/plugin/opener/) documentation.

All images are blocked, including remote tracking pixels, data URLs and inline/CID
images. Alternative text may appear, and MIME image attachments can still be saved
through the attachment workflow. There is no remote-images toggle yet. Links are
inactive in the sample mailbox.

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
unsanitised control must remain readable, both origin checks must report an
opaque origin, and the parent sentinel must remain unchanged. Do not follow links
in the raw control. `http://127.0.0.1:4174/status` must report `{"probes":0}`.
Stop the server with Ctrl+C. The fixture's resource probes target only this server.

This check was run in Chromium for 0.4.0 with no probe requests. CI runs the
Rust and UI tests on Windows x64, Windows x86 and Linux x64. Native WebView2 and
WebKitGTK GUI behaviour and real-provider integration need additional manual tests;
a browser check is not a substitute for those platform tests.
