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
import { PreferencesProvider } from "./preferences";
import { emptyAccount, type Draft, type Submission } from "./model";
import App from "./App";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  destroy: vi.fn(),
  close: undefined as
    undefined | ((event: { preventDefault: () => void }) => Promise<void>),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    destroy: mocks.destroy,
    onCloseRequested: async (fn: typeof mocks.close) => {
      mocks.close = fn;
      return () => undefined;
    },
  }),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
const account = {
  ...emptyAccount,
  email: "user@example.org",
  imapHost: "imap.example.org",
  username: "user",
  rememberPassword: false,
};
const savedDraft: Draft = {
  id: "7e9a2992-3552-4704-bde0-de4330d6b8e9",
  revision: 2,
  to: "a@example.org",
  subject: "Recovered draft",
  body: "Saved body",
};
function mount() {
  render(
    <PreferencesProvider>
      <App />
    </PreferencesProvider>,
  );
}
beforeEach(() => {
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "load_settings")
      return { language: "en", autoUpdate: false };
    if (command === "load_startup")
      return {
        account,
        folders: [
          { name: "INBOX", label: "INBOX", selectable: true },
          { name: "Sent", label: "Sent", selectable: true, role: "sent" },
        ],
        snapshot: {
          messages: [
            {
              uid: 1,
              subject: "Cached email",
              from: "a@example.org",
              to: account.email,
              date: new Date().toISOString(),
              unread: true,
              flagged: false,
              size: 10,
            },
          ],
          uidValidity: 7,
          offline: true,
        },
      };
    if (command === "local_work") return [[savedDraft], []];
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("offline drafts and delivery", () => {
  it("opens cached mail without forcing setup or accessing credentials", async () => {
    mount();
    await screen.findByText("Cached email");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).not.toContain(
      "list_messages",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Local drafts & delivery" }),
    );
    await screen.findByText("Recovered draft");
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Message body",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Saved body");
    expect(
      (screen.getByRole("combobox", { name: "Sent copy" }) as HTMLSelectElement)
        .value,
    ).toBe("Sent");
  });
  it("keeps the window open if saving fails and waits for the newest edit before closing", async () => {
    mount();
    await screen.findByText("Cached email");
    fireEvent.click(
      screen.getByRole("button", { name: "Local drafts & delivery" }),
    );
    await screen.findByText("Recovered draft");
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) =>
      command === "save_draft"
        ? Promise.reject("disk full")
        : original(command, args),
    );
    const event = { preventDefault: vi.fn() };
    await act(async () => {
      await mocks.close!(event);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saves = 0;
    mocks.invoke.mockImplementation((command, args) =>
      command === "save_draft"
        ? ++saves === 1
          ? pending
          : Promise.resolve()
        : original(command, args),
    );
    let closing!: Promise<void>;
    await act(async () => {
      closing = mocks.close!(event);
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message body" }), {
      target: { value: "newest edit" },
    });
    await act(async () => {
      release();
      await closing;
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
    const calls = mocks.invoke.mock.calls.filter(
      ([command]) => command === "save_draft",
    );
    expect(calls.at(-1)?.[1].draft.body).toBe("newest edit");
  });
  it("retrying a Sent copy uses the existing submission and offers no SMTP resend", async () => {
    const entry: Submission = {
      draft: savedDraft,
      status: "copy_pending",
      sentFolder: "Sent",
      detail: "offline",
    };
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) =>
      command === "local_work"
        ? Promise.resolve([[], [entry]])
        : original(command, args),
    );
    mount();
    await screen.findByText("Cached email");
    fireEvent.click(
      screen.getByRole("button", { name: "Local drafts & delivery" }),
    );
    await screen.findByText("Sent · IMAP copy pending");
    expect(
      screen.queryByRole("button", { name: "Open as a new draft" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Check Sent copy again" }),
    );
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith(
        "send_message",
        expect.objectContaining({ draft: savedDraft, sentFolder: "Sent" }),
      ),
    );
  });
  it("automatically saves edited drafts with their account and next revision", async () => {
    mount();
    await screen.findByText("Cached email");
    fireEvent.click(
      screen.getByRole("button", { name: "Local drafts & delivery" }),
    );
    await screen.findByText("Recovered draft");
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message body" }), {
      target: { value: "Autosaved content" },
    });
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("save_draft", {
        accountId: JSON.stringify([
          account.imapHost,
          account.imapPort,
          account.username,
        ]),
        draft: { ...savedDraft, revision: 3, body: "Autosaved content" },
      }),
    );
  });
});
