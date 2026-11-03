// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreferencesProvider, usePreferences } from "./preferences";
import { htmlDocument, MAIL_CSP } from "./htmlDocument";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), desktop: true }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => mocks.desktop,
  invoke: mocks.invoke,
}));
let media: EventTarget & {
  matches: boolean;
  addEventListener: EventTarget["addEventListener"];
  removeEventListener: EventTarget["removeEventListener"];
};
beforeEach(() => {
  localStorage.clear();
  mocks.desktop = true;
  mocks.invoke
    .mockReset()
    .mockResolvedValue({ language: "en", autoUpdate: false });
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const mount = () =>
  renderHook(usePreferences, { wrapper: PreferencesProvider });

it("migrates old settings and follows system changes until explicitly overridden", async () => {
  const h = mount();
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  expect(h.result.current.settings.theme).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("light");
  await act(() =>
    h.result.current.save({ ...h.result.current.settings, theme: "dark" }),
  );
  expect(mocks.invoke).toHaveBeenCalledWith("save_settings", {
    settings: { language: "en", autoUpdate: false, theme: "dark" },
  });
  act(() => {
    media.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  await act(() =>
    h.result.current.save({ ...h.result.current.settings, theme: "system" }),
  );
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("retains the selected theme after a browser remount", async () => {
  mocks.desktop = false;
  const h = mount();
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  await act(() =>
    h.result.current.save({ ...h.result.current.settings, theme: "light" }),
  );
  h.unmount();
  const reopened = mount();
  await waitFor(() => expect(reopened.result.current.ready).toBe(true));
  expect(reopened.result.current.settings.theme).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
});

it("keeps the previous theme when desktop persistence fails", async () => {
  const h = mount();
  await waitFor(() => expect(h.result.current.ready).toBe(true));
  mocks.invoke.mockRejectedValueOnce("disk full");
  await act(() =>
    h.result.current.save({ ...h.result.current.settings, theme: "light" }),
  );
  expect(h.result.current.settings.theme).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(h.result.current.error).toBe("disk full");
  expect(localStorage.getItem("email-theme")).toBeNull();
});

it("themes formatted mail without weakening its content policy", () => {
  const html = '<p style="color: black; background-color: white">Message</p>';
  const dark = htmlDocument(html, "dark");
  expect(dark).toContain("color-scheme: dark");
  expect(dark).toContain("color: inherit !important");
  expect(dark).toContain(MAIL_CSP);
  expect(dark).toContain(html);
  expect(htmlDocument(html, "light")).not.toContain("color-scheme: dark");
});
