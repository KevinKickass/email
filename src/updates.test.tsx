// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesProvider, usePreferences } from "./preferences";
import { useUpdates } from "./updates";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

function mount(open = false) {
  return renderHook(
    ({ open }) => ({
      updates: useUpdates(open),
      preferences: usePreferences(),
    }),
    {
      initialProps: { open },
      wrapper: PreferencesProvider,
    },
  );
}
function candidate() {
  return {
    version: "0.2.0",
    body: "Release notes",
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}
beforeEach(() => {
  mocks.invoke
    .mockReset()
    .mockResolvedValue({ autoUpdate: false, language: "system" });
  mocks.check.mockReset().mockResolvedValue(null);
  mocks.relaunch.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("opt-in updater", () => {
  it("does no background networking by default, while allowing a manual check", async () => {
    const h = mount();
    await waitFor(() => expect(h.result.current.preferences.ready).toBe(true));
    vi.useFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000));
    expect(mocks.check).not.toHaveBeenCalled();
    await act(() => h.result.current.updates.checkNow());
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(h.result.current.updates.status).toBe("current");
  });
  it("downloads only after opt-in and requires a deliberate install with no open work", async () => {
    const update = candidate();
    mocks.check.mockResolvedValue(update);
    const h = mount(true);
    await waitFor(() => expect(h.result.current.preferences.ready).toBe(true));
    vi.useFakeTimers();
    await act(() =>
      h.result.current.preferences.save({ autoUpdate: true, language: "en" }),
    );
    expect(mocks.invoke).toHaveBeenCalledWith("save_settings", {
      settings: { autoUpdate: true, language: "en" },
    });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(update.download).toHaveBeenCalledOnce();
    expect(h.result.current.updates.status).toBe("ready");
    expect(update.install).not.toHaveBeenCalled();
    await act(() => h.result.current.updates.installNow());
    expect(update.install).not.toHaveBeenCalled();
    h.rerender({ open: false });
    await act(() => h.result.current.updates.installNow());
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
  it("honours opting out while a background check is in flight", async () => {
    mocks.invoke.mockResolvedValue({ autoUpdate: true, language: "de" });
    let resolve!: (update: ReturnType<typeof candidate>) => void;
    mocks.check.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.useFakeTimers();
    const h = mount();
    await act(async () => {});
    expect(h.result.current.preferences.ready).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    await act(() =>
      h.result.current.preferences.save({ autoUpdate: false, language: "de" }),
    );
    const update = candidate();
    await act(async () => {
      resolve(update);
    });
    expect(update.download).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000));
    expect(mocks.check).toHaveBeenCalledOnce();
  });
  it("never offers installation after download/signature verification fails", async () => {
    const update = candidate();
    update.download.mockRejectedValue(new Error("Invalid signature"));
    mocks.check.mockResolvedValue(update);
    const h = mount();
    await waitFor(() => expect(h.result.current.preferences.ready).toBe(true));
    await act(() => h.result.current.updates.checkNow());
    await act(() => h.result.current.updates.downloadNow());
    expect(h.result.current.updates.status).toBe("error");
    await act(() => h.result.current.updates.installNow());
    expect(update.install).not.toHaveBeenCalled();
    expect(update.close).toHaveBeenCalledOnce();
  });
});
