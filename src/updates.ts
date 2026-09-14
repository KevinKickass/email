import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { usePreferences } from "./preferences";

export function mayCheckAutomatically(
  ready: boolean,
  enabled: boolean,
  desktop: boolean,
) {
  return ready && enabled && desktop;
}
export function useUpdates(hasOpenWork: boolean) {
  const { settings, ready } = usePreferences();
  const enabled = useRef(settings.autoUpdate);
  enabled.current = settings.autoUpdate;
  const working = useRef(hasOpenWork);
  working.current = hasOpenWork;
  const operation = useRef(false);
  const update = useRef<Update | null>(null);
  const [status, setStatus] = useState<
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "restart"
    | "error"
  >("idle");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);

  async function download(candidate: Update) {
    setStatus("downloading");
    setProgress(null);
    let received = 0;
    let total = 0;
    await candidate.download(
      (event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") received += event.data.chunkLength;
        if (total)
          setProgress(Math.min(100, Math.round((received / total) * 100)));
      },
      { timeout: 300_000 },
    );
    // The plugin verifies the signature before this promise resolves.
    setStatus("ready");
  }
  async function fail(e: unknown) {
    setError(String(e));
    setStatus("error");
    const candidate = update.current;
    update.current = null;
    await candidate?.close().catch(() => {});
  }
  async function checkNow(automatic = false) {
    if (!isTauri() || operation.current || update.current) return;
    if (automatic && !mayCheckAutomatically(ready, enabled.current, true))
      return;
    operation.current = true;
    setStatus("checking");
    setError("");
    setVersion("");
    setNotes("");
    try {
      const candidate = await check({ timeout: 20_000 });
      if (!candidate) {
        setStatus("current");
        return;
      }
      update.current = candidate;
      setVersion(candidate.version);
      setNotes(candidate.body ?? "");
      setStatus("available");
      if (automatic && enabled.current) await download(candidate);
    } catch (e) {
      await fail(e);
    } finally {
      operation.current = false;
    }
  }
  async function downloadNow() {
    if (!update.current || operation.current) return;
    operation.current = true;
    setError("");
    try {
      await download(update.current);
    } catch (e) {
      await fail(e);
    } finally {
      operation.current = false;
    }
  }
  async function installNow() {
    if (
      !update.current ||
      operation.current ||
      working.current ||
      status !== "ready"
    )
      return;
    operation.current = true;
    setStatus("installing");
    setError("");
    try {
      await update.current.install();
    } catch (e) {
      await fail(e);
      operation.current = false;
      return;
    }
    // Windows exits inside install(); Linux needs an explicit restart.
    setStatus("restart");
    try {
      await relaunch();
    } catch (e) {
      setError(String(e));
    } finally {
      operation.current = false;
    }
  }
  async function restartNow() {
    if (working.current || operation.current) return;
    try {
      await relaunch();
    } catch (e) {
      setError(String(e));
    }
  }
  const checker = useRef(checkNow);
  checker.current = checkNow;
  useEffect(() => {
    if (!mayCheckAutomatically(ready, settings.autoUpdate, isTauri())) return;
    const initial = setTimeout(() => void checker.current(true), 15_000);
    const interval = setInterval(
      () => void checker.current(true),
      6 * 60 * 60 * 1000,
    );
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [ready, settings.autoUpdate]);
  return {
    status,
    version,
    notes,
    error,
    progress,
    checkNow,
    downloadNow,
    installNow,
    restartNow,
  };
}
