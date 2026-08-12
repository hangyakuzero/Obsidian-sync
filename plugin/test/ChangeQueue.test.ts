import { describe, expect, it } from "vitest";
import { ChangeQueue } from "../src/sync/ChangeQueue";
import { SyncState, SyncStateBackend } from "../src/state/SyncState";
import type { Change } from "@syncvault/shared";

function makeState(): { state: SyncState; reload: () => Promise<SyncState> } {
  const store = new Map<string, unknown>();
  const backend: SyncStateBackend = {
    load: async () => {
      const data = store.get("data") as Partial<SyncVaultState> | undefined;
      return data?.data;
    },
    save: async (data) => store.set("data", { data }),
  };
  const state = new SyncState(backend);
  void state.load();
  return {
    state,
    reload: async () => {
      const fresh = new SyncState(backend);
      await fresh.load();
      return fresh;
    },
  };
}

interface SyncVaultState {
  data?: unknown;
}

function change(over: Partial<Change>): Change {
  return {
    operationId: Math.random().toString(36),
    revision: 0,
    deviceId: "dev-test",
    path: "a.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    payload: "aGk=",
    ...over,
  };
}

describe("ChangeQueue", () => {
  it("persists and survives restart", async () => {
    const { state, reload } = makeState();
    const queue = new ChangeQueue(state);
    const c = change({ operationId: "op-1", path: "notes/x.md", payload: "b2g=" });
    await queue.enqueue(c);

    const fresh: SyncState = await reload();
    expect(fresh.pendingChanges.length).toBe(1);
    expect(fresh.pendingChanges[0].operationId).toBe("op-1");
    expect(fresh.pendingChanges[0].payload).toBe("b2g=");
  });

  it("coalesces pending writes for the same path", async () => {
    const { state } = makeState();
    const queue = new ChangeQueue(state);
    await queue.enqueue(change({ operationId: "op-1", path: "a.md", operation: "create", payload: "b2xl" }));
    await queue.enqueue(change({ operationId: "op-2", path: "a.md", operation: "modify", payload: "b3U=" }));
    await queue.enqueue(change({ operationId: "op-3", path: "b.md", operation: "create", payload: "b2s=" }));
    expect(queue.size()).toBe(2);
    expect(queue.get("op-2")).toBeDefined();
    expect(queue.get("op-1")).toBeUndefined();
  });

  it("delete supersedes pending write and create-then-rename keeps the final path", async () => {
    const { state } = makeState();
    const queue = new ChangeQueue(state);
    await queue.enqueue(change({ operationId: "op-1", path: "a.md", operation: "modify" }));
    await queue.enqueue(change({ operationId: "op-2", path: "a.md", operation: "delete" }));
    expect(queue.size()).toBe(1);
    expect(queue.items[0].operation).toBe("delete");

    await queue.enqueue(change({ operationId: "op-3", path: "c.md", operation: "create" }));
    await queue.enqueue(
      change({ operationId: "op-4", path: "d.md", oldPath: "c.md", operation: "rename" }),
    );
    expect(queue.get("op-3")).toBeDefined();
    expect(queue.get("op-3")?.path).toBe("d.md");
    expect(queue.get("op-4")).toBeUndefined();
    expect(queue.size()).toBe(2);
  });

  it("removes by operationId and tracks attempts", async () => {
    const { state } = makeState();
    const queue = new ChangeQueue(state);
    await queue.enqueue(change({ operationId: "op-1" }));
    expect(queue.has("op-1")).toBe(true);
    await queue.markAttempted("op-1");
    expect(queue.get("op-1")?.attempts).toBe(1);
    await queue.remove("op-1");
    expect(queue.has("op-1")).toBe(false);
    expect(queue.size()).toBe(0);
  });

  it("does not duplicate an identical pending change", async () => {
    const { state } = makeState();
    const queue = new ChangeQueue(state);
    const c = change({ operationId: "op-1", payload: "c2FtZQ==" });
    await queue.enqueue(c);
    await queue.enqueue({ ...c, operationId: "op-2" });
    expect(queue.size()).toBe(1);
  });
});
