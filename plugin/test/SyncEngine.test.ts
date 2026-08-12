import { describe, expect, it, vi } from "vitest";
import { SyncEngine, SyncStatus, VaultOps, Connection } from "../src/sync/SyncEngine";
import { ConnectionCallbacks } from "../src/sync/SyncConnection";
import { ChangeQueue } from "../src/sync/ChangeQueue";
import { VaultWatcher } from "../src/vault/VaultWatcher";
import { SyncState, SyncStateBackend } from "../src/state/SyncState";
import { Change, toBase64 } from "@syncvault/shared";

class FakeConnection implements Connection {
  connected = true;
  sent: Change[] = [];
  acks: number[] = [];
  handlers: ConnectionCallbacks;

  constructor(handlers: ConnectionCallbacks) {
    this.handlers = handlers;
  }

  connect(): void {
    // no-op; auto-connected
  }

  disconnect(): void {
    this.connected = false;
  }

  sendChange(change: Change): boolean {
    this.sent.push(change);
    return true;
  }

  sendAck(revision: number): boolean {
    this.acks.push(revision);
    return true;
  }
}

function makeConfiguredState(): SyncState {
  const backend: SyncStateBackend = {
    load: async () => undefined,
    save: async () => undefined,
  };
  const state = new SyncState(backend);
  state.save({
    accountId: "acc",
    vaultId: "vault",
    deviceId: "dev-0001",
    deviceToken: "tok",
    lastRevision: 3,
  });
  return state;
}

interface Rig {
  state: SyncState;
  queue: ChangeQueue;
  watcher: VaultWatcher;
  conn: FakeConnection;
  engine: SyncEngine;
  writes: { path: string; bytes: Uint8Array }[];
  removes: string[];
  renames: { oldPath: string; newPath: string }[];
}

function makeRig(): Rig {
  const state = makeConfiguredState();
  const queue = new ChangeQueue(state);
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const removes: string[] = [];
  const renames: { oldPath: string; newPath: string }[] = [];
  const vault: VaultOps = {
    write: async (path, bytes) => {
      // Simulate Obsidian: writing fires a vault modify event, which must be suppressed.
      watcher.track({ kind: "modify", path });
      writes.push({ path, bytes });
    },
    remove: async (path) => {
      watcher.track({ kind: "delete", path });
      removes.push(path);
    },
    rename: async (oldPath, newPath) => {
      watcher.track({ kind: "rename", path: newPath, oldPath });
      renames.push({ oldPath, newPath });
    },
  };
  const watcher = new VaultWatcher({
    readBytes: async () => null,
    getBaseRevision: () => state.lastRevision,
    onChange: (change) => queue.enqueue(change),
  });
  let conn: FakeConnection | null = null;
  const engine = new SyncEngine(state, queue, watcher, vault, () => undefined, () => undefined, (handlers) => {
    conn = new FakeConnection(handlers);
    return conn;
  });
  return { state, queue, watcher, conn: conn!, engine, writes, removes, renames };
}

describe("SyncEngine", () => {
  it("flushes queued changes and advances the cursor on acceptance", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(
      change({ operationId: "op-1", path: "a.md", operation: "create", baseRevision: 3, payload: toBase64(new TextEncoder().encode("hi")) }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    expect(rig.conn.sent[0].baseRevision).toBe(3);
    // simulate server acceptance
    rig.conn.handlers.onAccepted("op-1", 4);
    await synced;
    expect(rig.queue.size()).toBe(0);
    expect(rig.state.lastRevision).toBe(4);
  });

  it("applies a remote change, suppresses the echo, sends ACK, advances cursor", async () => {
    const rig = makeRig();
    rig.engine.start();
    const remote: Change = change({
      operationId: "remote-1",
      revision: 4,
      path: "Hello.md",
      operation: "create",
      baseRevision: 0,
      payload: toBase64(new TextEncoder().encode("# Hello")),
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.writes.length).toBe(1);
    expect(rig.writes[0].path).toBe("Hello.md");
    expect(new TextDecoder().decode(rig.writes[0].bytes)).toBe("# Hello");
    // the vault write fired a modify event but suppression prevented a queue echo
    expect(rig.queue.size()).toBe(0);
    expect(rig.conn.acks).toEqual([4]);
    expect(rig.state.lastRevision).toBe(4);
  });

  it("removes a queued change when the server reports a conflict", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(
      change({ operationId: "op-1", path: "a.md", operation: "update", baseRevision: 3, payload: toBase64(new TextEncoder().encode("local")) }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    rig.conn.handlers.onConflict({
      operationId: "op-1",
      path: "a.md",
      conflictPath: "a (conflict-dev-0001-20260812123000).md",
      serverRevision: 4,
    });
    await synced;
    expect(rig.queue.size()).toBe(0);
    expect(rig.state.lastRevision).toBe(3);
  });

  it("keeps the queued change when the connection drops mid-flush", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(change({ operationId: "op-1", path: "a.md" }));
    rig.conn.connected = false; // offline
    await rig.engine.syncNow();
    expect(rig.conn.sent.length).toBe(0);
    expect(rig.queue.size()).toBe(1);

    // reconnect: queue flushes successfully this time
    rig.conn.connected = true;
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    rig.conn.handlers.onAccepted("op-1", 4);
    await synced;
    expect(rig.queue.size()).toBe(0);
    expect(rig.state.lastRevision).toBe(4);
  });

  it("applies a remote delete without echo", async () => {
    const rig = makeRig();
    const remote: Change = change({ operationId: "remote-del", revision: 5, path: "bye.md", operation: "delete" });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.removes).toEqual(["bye.md"]);
    expect(rig.queue.size()).toBe(0); // delete event was suppressed
    expect(rig.conn.acks).toEqual([5]);
  });

  it("applies a remote rename without echo", async () => {
    const rig = makeRig();
    const remote: Change = change({ operationId: "remote-rn", revision: 6, path: "new.md", oldPath: "old.md", operation: "rename" });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.renames).toEqual([{ oldPath: "old.md", newPath: "new.md" }]);
    expect(rig.queue.size()).toBe(0);
    expect(rig.conn.acks).toEqual([6]);
    expect(rig.state.lastRevision).toBe(6);
  });

  it("does not start a second sync while one is in flight", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(change({ operationId: "op-1", path: "a.md" }));
    await rig.queue.enqueue(change({ operationId: "op-2", path: "b.md" }));
    const p1 = rig.engine.syncNow();
    const p2 = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1); // only the first in-flight sync sends
    rig.conn.handlers.onAccepted("op-1", 4);
    await new Promise((r) => setTimeout(r, 10)); // let the loop send op-2 and register its ack
    rig.conn.handlers.onAccepted("op-2", 5);
    await Promise.all([p1, p2]);
    expect(rig.state.lastRevision).toBe(5);
    expect(rig.queue.size()).toBe(0);
  });
});

let opSeq = 1000;
function change(over: Partial<Change>): Change {
  opSeq += 1;
  return {
    operationId: `op-${opSeq}`,
    revision: 0,
    deviceId: "dev-0001",
    path: "a.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    ...over,
  };
}