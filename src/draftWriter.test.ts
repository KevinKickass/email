import { describe, expect, it, vi } from "vitest";
import { createDraftWriter } from "./draftWriter";
import type { Draft } from "./model";
const draft: Draft = {
  id: "id",
  revision: 1,
  to: "a@example.org",
  subject: "Subject",
  body: "original",
};
describe("draft persistence queue", () => {
  it("serializes snapshots and keeps the original account across a delayed save", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi
      .fn()
      .mockImplementationOnce(() => blocked)
      .mockResolvedValue(undefined);
    const save = createDraftWriter(write);
    const first = save("first account", draft);
    const changed = { ...draft, revision: 2, body: "latest" };
    const second = save("first account", changed);
    changed.body = "edited again";
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await first;
    await second;
    expect(write.mock.calls[1]).toEqual([
      "first account",
      { ...draft, revision: 2, body: "latest" },
    ]);
  });
  it("reports disk errors while allowing a subsequent save", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const save = createDraftWriter(write);
    await expect(save("account", draft)).rejects.toThrow("disk full");
    await expect(
      save("account", { ...draft, revision: 2 }),
    ).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
