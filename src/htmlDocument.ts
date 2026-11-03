// Input is ONLY the Rust-sanitised Mail.html field (bodyVersion 2), never raw MIME.
// Keep this wrapper static: untrusted HTML may not contribute CSP, CSS or attributes.
export const MAIL_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function htmlDocument(html: string, theme: "light" | "dark" = "light") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}"><meta name="referrer" content="no-referrer"><style>
html { color-scheme: light; background: white; }
body { margin: 20px 24px; color: #34495b; font: 14px/1.6 "Segoe UI", Arial, sans-serif; overflow-wrap: anywhere; }
h1,h2,h3,h4,h5,h6 { line-height: 1.3; margin: 1em 0 .5em; color: #294867; }
h1 { font-size: 26px; } h2 { font-size: 22px; } h3 { font-size: 18px; }
p { margin: .7em 0; } table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
th,td { border: 1px solid #cbd5e1; padding: 8px 12px; text-align: left; }
blockquote { margin: 1em 0; padding: 0 16px; border-left: 3px solid #9bb2cc; }
pre { white-space: pre-wrap; } pre,code { font-family: monospace; }
hr { border: 0; border-top: 1px solid #dce3ec; margin: 18px 0; }
img { font-size: 12px; color: #65778b; max-width: 100%; }
a[data-mail-link] { text-decoration: underline; cursor: pointer; }
a[data-mail-link], a[data-mail-link] * { color: #255e96 !important; }
a[data-mail-link]:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
a[aria-disabled="true"] { cursor: default; }
img[data-mail-image]:not([src]) { display: inline-block; min-width: 48px; min-height: 24px; border: 1px dashed #8498ae; padding: 4px; }
${
  theme === "dark"
    ? `
html { color-scheme: dark; background: #18212c; }
body { color: #d5dfeb; }
body [style] { color: inherit !important; background-color: transparent !important; }
h1,h2,h3,h4,h5,h6 { color: #e4edf7; }
th,td,hr { border-color: #3a4b5f; }
blockquote { border-color: #729bc7; }
img { color: #a7b8ca; }
a[data-mail-link], a[data-mail-link] * { color: #8dbcf0 !important; }
`
    : ""
}
</style></head><body>${html}</body></html>`;
}
