// Manual browser regression check. All probes target this local server.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import ts from "typescript";
const raw = readFileSync("tests/fixtures/hostile-email.html", "utf8");
const result = spawnSync(
  "cargo",
  [
    "run",
    "--locked",
    "--quiet",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--example",
    "sanitize-html",
  ],
  { input: raw, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
);
if (result.status !== 0) throw new Error(result.stderr);
const clean = JSON.parse(result.stdout);
const compiled = ts.transpileModule(
  readFileSync("src/htmlDocument.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2021,
    },
  },
).outputText;
const { htmlDocument } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const frame = (title, html) =>
  `<h2>${title}</h2><iframe title="${title}" sandbox="" referrerpolicy="no-referrer" srcdoc="${escape(htmlDocument(html))}"></iframe>`;
const page = `<!doctype html><html><head><meta charset="utf-8"><title>email HTML privacy regression</title><script src="/check.js" defer></script><style>body{font:16px sans-serif;margin:24px}iframe{width:95%;height:350px;border:1px solid #aaa}</style></head><body><h1>email HTML privacy regression</h1><p id="sentinel">Parent unchanged</p><p>Both frames must remain readable. The server must report zero /probe requests. Do not follow links in the raw control.</p>${frame("Sanitised mail", clean.html)}${frame("Unsanitised sandbox control", raw)}</body></html>`;
const csp = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app
  .security.csp;
let probes = 0;
createServer((req, res) => {
  if (req.url.startsWith("/probe")) {
    ++probes;
    console.error("UNEXPECTED NETWORK REQUEST", req.url);
    res.writeHead(404);
    res.end();
    return;
  }
  if (req.url === "/check.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(`window.addEventListener('load', () => {
      document.querySelectorAll('iframe').forEach((frame) => {
        const result = document.createElement('p');
        result.className = 'origin-check';
        let blocked = false;
        try { void frame.contentWindow.document; } catch (e) { blocked = e.name === 'SecurityError'; }
        result.textContent = frame.title + ': ' + (blocked && frame.contentDocument === null ? 'opaque origin confirmed' : 'UNEXPECTED FRAME ACCESS');
        document.body.append(result);
      });
    });`);
    return;
  }
  if (req.url === "/status") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ probes }));
    return;
  }
  if (req.url !== "/") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
  });
  res.end(page);
}).listen(4174, "127.0.0.1", () =>
  console.log(
    "Open http://127.0.0.1:4174; inspect /status for zero probe requests. Stop with Ctrl+C.",
  ),
);
