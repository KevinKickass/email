import type { Draft } from "./model";

// Keep saves in order even when IPC acknowledgements arrive late. A failed save
// rejects its own caller without poisoning subsequent attempts.
export function createDraftWriter(
  write: (accountId: string, draft: Draft) => Promise<unknown>,
) {
  let tail = Promise.resolve();
  return (accountId: string, draft: Draft) => {
    const snapshot = { ...draft };
    const task = tail
      .then(() => write(accountId, snapshot))
      .then(() => undefined);
    tail = task.catch(() => undefined);
    return task;
  };
}
