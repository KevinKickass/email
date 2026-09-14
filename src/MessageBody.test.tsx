// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import MessageBody from "./MessageBody";
import { PreferencesProvider } from "./preferences";
import type { Mail } from "./model";
import { MAIL_CSP } from "./htmlDocument";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));
const message: Mail = {
  uid: 1,
  from: "a@example.org",
  replyTo: "",
  to: "b@example.org",
  subject: "HTML mail",
  date: "",
  unread: false,
  flagged: false,
  size: 100,
  bodyVersion: 1,
  body: "Original plain alternative",
  html: "<h2>Formatted mail</h2><p><strong>Bold text</strong></p>",
  links: ["https://example.org/actual-destination"],
};
function mount(mail = message, demo = false) {
  return render(
    <PreferencesProvider>
      <MessageBody message={mail} demo={demo} />
    </PreferencesProvider>,
  );
}
beforeEach(() => {
  invoke
    .mockReset()
    .mockImplementation(async (cmd) =>
      cmd === "load_settings"
        ? { language: "en", autoUpdate: false }
        : undefined,
    );
});
afterEach(cleanup);
describe("isolated HTML reader", () => {
  it("uses an opaque scriptless sandbox and CSP, then switches to the original plain alternative", async () => {
    mount();
    const frame = await screen.findByTitle("Formatted message content");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toBeNull();
    const source = frame.getAttribute("srcdoc")!;
    expect(source).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${MAIL_CSP}">`,
    );
    expect(source.indexOf("Content-Security-Policy")).toBeLessThan(
      source.indexOf("<body>"),
    );
    expect(source).toContain(message.html);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain(
      "open_web_link",
    );
    fireEvent.click(screen.getByRole("button", { name: "Plain text" }));
    expect(screen.getByText("Original plain alternative")).toBeTruthy();
    expect(screen.queryByTitle("Formatted message content")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "HTML" }));
    expect(screen.getByTitle("Formatted message content")).toBeTruthy();
  });
  it("displays the real URL and opens it only after an explicit click, keeping errors in the reader", async () => {
    mount();
    fireEvent.click(await screen.findByText("Web links (1)"));
    const target = screen.getByRole("button", {
      name: /https:\/\/example.org\/actual-destination/,
    });
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "open_web_link")
        throw "Der Link konnte nicht im Browser geöffnet werden.";
    });
    fireEvent.click(target);
    await screen.findByText("Could not open the link in your browser.");
    expect(invoke).toHaveBeenCalledWith("open_web_link", {
      url: message.links![0],
    });
  });
  it("never inserts legacy/unversioned HTML into an iframe and explains oversized HTML fallback", async () => {
    mount({
      ...message,
      bodyVersion: undefined,
      html: "<script>alert(1)</script>",
      htmlWarning:
        "HTML-Inhalt ist größer als 2 MiB. Nur-Text wird angezeigt, sofern vorhanden.",
    });
    await screen.findByText(
      "HTML content exceeds 2 MiB. Plain text is shown if available.",
    );
    expect(screen.queryByTitle("Formatted message content")).toBeNull();
    expect(screen.getByText("Original plain alternative")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
  });
  it("keeps links disabled in the sample mailbox and requires a local-only frame policy", async () => {
    mount(message, true);
    fireEvent.click(await screen.findByText("Web links (1)"));
    const button = screen.getByRole("button", {
      name: /actual-destination/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(invoke.mock.calls.map(([cmd]) => cmd)).not.toContain(
      "open_web_link",
    );
    const config = JSON.parse(
      readFileSync("src-tauri/tauri.conf.json", "utf8"),
    );
    expect(config.app.security.csp).toContain("frame-src 'self'");
    for (const directive of [
      "script-src 'none'",
      "img-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(MAIL_CSP).toContain(directive);
  });
});
