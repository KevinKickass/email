// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  bodyVersion: 2,
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
  it("loads images only after consent, reports partial failures and retries only missing images", async () => {
    const location = {
      accountId: "account",
      folder: "INBOX",
      uid: 1,
      uidValidity: 7,
    };
    const mail = {
      ...message,
      remoteImages: ["https://example.org/a.png", "https://example.org/b.png"],
    };
    render(
      <PreferencesProvider>
        <MessageBody message={mail} demo={false} location={location} />
      </PreferencesProvider>,
    );
    await screen.findByText("2 external images were blocked.");
    expect(
      invoke.mock.calls.some(([cmd]) => cmd === "load_message_images"),
    ).toBe(false);
    invoke.mockResolvedValueOnce({
      images: [{ index: 0, dataUrl: "data:image/png;base64,iVBORw==" }],
      failed: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Load images" }));
    await screen.findByText("An image could not be loaded.");
    expect(invoke).toHaveBeenCalledWith("load_message_images", {
      location,
      indices: [0, 1],
    });
    invoke.mockResolvedValueOnce({
      images: [{ index: 1, dataUrl: "data:image/png;base64,iVBORw==" }],
      failed: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("External images loaded for this message.");
    expect(invoke).toHaveBeenLastCalledWith("load_message_images", {
      location,
      indices: [1],
    });
    fireEvent.click(screen.getByRole("button", { name: "Block images again" }));
    await screen.findByText("2 external images were blocked.");
  });
  it("does not transfer image consent or late results to the next message", async () => {
    const mail = { ...message, remoteImages: ["https://example.org/a.png"] };
    const location = {
      accountId: "account",
      folder: "INBOX",
      uid: 1,
      uidValidity: 7,
    };
    const view = render(
      <PreferencesProvider>
        <MessageBody message={mail} demo={false} location={location} />
      </PreferencesProvider>,
    );
    await screen.findByText("An external image was blocked.");
    let finish!: (value: unknown) => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load images" }));
    await screen.findByText("Loading external images…");
    view.rerender(
      <PreferencesProvider>
        <MessageBody
          message={{ ...mail, uid: 2 }}
          demo={false}
          location={{ ...location, uid: 2 }}
        />
      </PreferencesProvider>,
    );
    await act(async () =>
      finish({
        images: [{ index: 0, dataUrl: "data:image/png;base64,iVBORw==" }],
        failed: 0,
      }),
    );
    await screen.findByText("An external image was blocked.");
    expect(
      screen.queryByText("External images loaded for this message."),
    ).toBeNull();
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "load_message_images"),
    ).toHaveLength(1);
  });
  it("shows load errors and allows retry without claiming that images loaded", async () => {
    render(
      <PreferencesProvider>
        <MessageBody
          message={{ ...message, remoteImages: ["https://example.org/a.png"] }}
          demo={false}
          location={{
            accountId: "account",
            folder: "INBOX",
            uid: 1,
            uidValidity: 7,
          }}
        />
      </PreferencesProvider>,
    );
    await screen.findByRole("button", { name: "Load images" });
    invoke.mockRejectedValueOnce("offline");
    fireEvent.click(screen.getByRole("button", { name: "Load images" }));
    await screen.findByText("offline");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Load images",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.getByText("An external image was blocked.")).toBeTruthy();
  });
  it("uses a scriptless sandbox and CSP, then switches to the original plain alternative", async () => {
    mount();
    const frame = await screen.findByTitle("Formatted message content");
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
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
      "img-src data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
    ])
      expect(MAIL_CSP).toContain(directive);
  });
});
