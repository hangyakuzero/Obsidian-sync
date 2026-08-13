import { describe, expect, it, vi } from "vitest";
import { SyncEngine, SyncStatus, VaultOps, Connection, EngineOptions } from "../src/sync/SyncEngine";
import { ConnectionCallbacks } from "../src/sync/SyncConnection";
import { ChangeQueue } from "../src/sync/ChangeQueue";
import { VaultWatcher } from "../src/vault/VaultWatcher";
import { SyncState, SyncStateBackend } from "../src/state/SyncState";
import { MemoryStaging } from "../src/storage/Staging";
import { Change, fromBase64, toBase64 } from "@syncvault/shared";
import { sha256Hex } from "../src/hashing/hash";
import { AuthManager } from "../src/auth/AuthManager";
import { SyncClient } from "../src/api/SyncClient";

class FakeConnection implements Connection {
  connected = true;
  advanceCursorOnAccept = true;
  sent: Change[] = [];
  acks: number[] = [];
  handlers: ConnectionCallbacks;
  contentByPath = new Map<string, Uint8Array<ArrayBuffer>>();

  constructor(handlers: ConnectionCallbacks) {
    this.handlers = handlers;
  }

  connect(): void {
    // no-op; the test toggles `connected` manually (mirrors the transport's
    // connected flag, which the engine can only influence via connect()).
  }

  disconnect(): void {
    this.connected = false;
  }

  sendChange(change: Change, bytes?: Uint8Array): boolean {
    this.sent.push(change);
    return true;
  }

  sendAck(revision: number): boolean {
    this.acks.push(revision);
    return true;
  }

  async fetchContent(change: Change): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.contentByPath.get(change.path) ?? null;
  }

  async pull(): Promise<{ currentRevision: number; changes: Change[]; resyncRequired: boolean }> {
    return { currentRevision: 0, changes: [], resyncRequired: false };
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
  vault: VaultOps;
  conn: FakeConnection;
  engine: SyncEngine;
  writes: { path: string; bytes: Uint8Array }[];
  removes: string[];
  renames: { oldPath: string; newPath: string }[];
  files: Map<string, Uint8Array<ArrayBuffer>>;
}

function makeRig(options: EngineOptions = {}): Rig {
  const state = makeConfiguredState();
  const queue = new ChangeQueue(state);
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const removes: string[] = [];
  const renames: { oldPath: string; newPath: string }[] = [];
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
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
    readFile: async (path) => files.get(path) ?? null,
    stat: async (path) => (files.has(path) ? "file" : null),
  };
  const watcher = new VaultWatcher({
    readBytes: async () => null,
    getBaseRevision: () => state.lastRevision,
    onChange: (change) => queue.enqueue(change),
  });
  let conn: FakeConnection | null = null;
  const engine = new SyncEngine(state, queue, watcher, vault, () => undefined, () => undefined, {
    connectionFactory: (handlers) => {
      conn = new FakeConnection(handlers);
      return conn;
    },
    ...options,
  });
  return { state, queue, watcher, vault, conn: conn!, engine, writes, removes, renames, files };
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

  it("accepts a queued change with a stale base revision (last-write-wins)", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(
      change({ operationId: "op-1", path: "a.md", operation: "update", baseRevision: 3, payload: toBase64(new TextEncoder().encode("local")) }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    // The server no longer rejects stale uploads with a conflict copy; the
    // push is accepted and the cursor advances to the server revision.
    rig.conn.handlers.onAccepted("op-1", 4);
    await synced;
    expect(rig.queue.size()).toBe(0);
    expect(rig.state.lastRevision).toBe(4);
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

  it("stamps the authenticated deviceId on queued changes at send time", async () => {
    const rig = makeRig();
    // Simulate a change captured before identity was configured (deviceId "").
    await rig.queue.enqueue(
      change({ operationId: "op-0", deviceId: "", path: "x.md", operation: "create" }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    expect(rig.conn.sent[0].deviceId).toBe("dev-0001");
    rig.conn.handlers.onAccepted("op-0", 4);
    await synced;
  });

  it("applies a remote delete without echo", async () => {
    const rig = makeRig();
    rig.files.set("bye.md", new Uint8Array(new TextEncoder().encode("x").buffer as ArrayBuffer));
    const remote: Change = change({ operationId: "remote-del", revision: 5, path: "bye.md", operation: "delete" });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.removes).toEqual(["bye.md"]);
    expect(rig.queue.size()).toBe(0); // delete event was suppressed
    expect(rig.conn.acks).toEqual([5]);
  });

  it("applies a remote delete without echo when the target is already gone", async () => {
    const rig = makeRig();
    const remote: Change = change({ operationId: "remote-del", revision: 5, path: "bye.md", operation: "delete" });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    // idempotent: nothing to remove, but the op still ACKs and advances
    expect(rig.removes).toEqual([]);
    expect(rig.conn.acks).toEqual([5]);
  });

  it("applies a remote rename without echo", async () => {
    const rig = makeRig();
    rig.files.set("old.md", new Uint8Array(new TextEncoder().encode("x").buffer as ArrayBuffer));
    const remote: Change = change({ operationId: "remote-rn", revision: 6, path: "new.md", oldPath: "old.md", operation: "rename" });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.renames).toEqual([{ oldPath: "old.md", newPath: "new.md" }]);
    expect(rig.queue.size()).toBe(0);
    expect(rig.conn.acks).toEqual([6]);
    expect(rig.state.lastRevision).toBe(6);
  });

  it("polls pulled changes, applies them, ACKs and advances the cursor", async () => {
    const rig = makeRig();
    const pulled: Change = change({
      operationId: "remote-1",
      revision: 7,
      path: "pulled.md",
      operation: "create",
      payload: toBase64(new TextEncoder().encode("hello")),
    });
    let served = false;
    (rig.conn as unknown as FakeConnection & { pullOverride?: unknown }).pull = async () => {
      if (served) return { currentRevision: 7, resyncRequired: false, changes: [] };
      served = true;
      return {
        currentRevision: 7,
        resyncRequired: false,
        changes: [pulled],
      };
    };
    await rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.writes.length).toBe(1);
    expect(rig.writes[0].path).toBe("pulled.md");
    expect(rig.state.lastRevision).toBe(7);
    expect(rig.conn.acks).toEqual([7]);
    expect(rig.queue.size()).toBe(0);
  });

  it("seeds local files with their real content", async () => {
    const rig = makeRig();
    rig.engine["scanner"] = {
      listFiles: async () => [
        { path: "notes.md", size: 5 },
        { path: "empty.md", size: 0 },
      ],
      readBytes: async (path) =>
        path === "notes.md"
          ? (new TextEncoder().encode("# hi").buffer as ArrayBuffer)
          : new ArrayBuffer(0),
    };
    await rig.engine["maybeSeed"]();
    expect(rig.queue.size()).toBe(2);
    const notes = rig.queue.items.find((c) => c.path === "notes.md")!;
    expect(notes.operation).toBe("create");
    expect(notes.content?.byteLength).toBe(4);
    expect(notes.content?.hash).toBe(
      await sha256Hex(new TextEncoder().encode("# hi")),
    );
    const empty = rig.queue.items.find((c) => c.path === "empty.md")!;
    expect(empty.payload).toBe("");
    expect(rig.state.seeded).toBe(true);
  });

  it("does not mark seeded when a file read fails mid-scan, and retries", async () => {
    const rig = makeRig();
    let failFirst = true;
    rig.engine["scanner"] = {
      listFiles: async () => [{ path: "a.md", size: 1 }, { path: "b.md", size: 1 }],
      readBytes: async (path) => {
        if (path === "b.md" && failFirst) {
          failFirst = false;
          throw new Error("transient read error");
        }
        return (new TextEncoder().encode("x").buffer as ArrayBuffer);
      },
    };
    await rig.engine["maybeSeed"]();
    // a.md was enqueued before the b.md read threw; seed stays incomplete
    expect(rig.state.seeded).toBe(false);
    expect(rig.queue.size()).toBe(1);
    await rig.engine["maybeSeed"]();
    expect(rig.state.seeded).toBe(true);
    expect(rig.queue.size()).toBe(2);
  });

  it("pauses sync only after repeated failures to apply a remote change", async () => {
    const rig = makeRig({ applyStrikeWindowMs: 10 });
    rig.vault.write = async () => {
      throw new Error("disk full");
    };
    const remote = change({
      operationId: "remote-broken",
      revision: 4,
      path: "x.md",
      operation: "create",
      payload: toBase64(new TextEncoder().encode("hi")),
    });
    // the first failure retries instead of destroying sync
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.engine.status).toBe("syncing");
    expect(rig.engine.isPaused).toBe(false);
    // never ACK an unapplied change
    expect(rig.state.lastRevision).toBe(3);
    expect(rig.conn.acks).toEqual([]);
    // three spaced failures pause once with a notice
    for (let i = 0; i < 2; i++) {
      rig.conn.handlers.onRemoteChange(remote);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(rig.engine.isPaused).toBe(true);
    expect(rig.engine.status).toBe("paused");
    // resume clears the pause and resumes polling
    await rig.engine.resume();
    expect(rig.engine.isPaused).toBe(false);
  });

  it("drops a queued change rejected as unrecoverable and continues", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(
      change({ operationId: "op-legacy", path: "old.md", operation: "create" }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    rig.conn.handlers.onRejected?.("op-legacy", "PAYLOAD_REQUIRED", "file content required");
    await synced;
    expect(rig.queue.size()).toBe(0);
    // cursor does not move for a rejected upload
    expect(rig.state.lastRevision).toBe(3);
  });

  it("seeds local files once, skipping applied, .obsidian and oversized paths", async () => {
    const rig = makeRig();
    rig.engine["scanner"] = {
      listFiles: async () => [
        { path: "local-only.md", size: 100 },
        { path: "already-on-server.md", size: 200 },
        { path: ".obsidian/workspace", size: 50 },
        { path: "big.bin", size: 20 * 1024 * 1024 },
      ],
    };
    await rig.state.markApplied("already-on-server.md");
    await rig.engine["maybeSeed"]();
    expect(rig.queue.size()).toBe(1);
    expect(rig.queue.items[0].path).toBe("local-only.md");
    expect(rig.queue.items[0].operation).toBe("create");
    expect(rig.state.seeded).toBe(true);
    // second call is a no-op
    await rig.engine["maybeSeed"]();
    expect(rig.queue.size()).toBe(1);
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

  it("HTTP cursor rule: accept does not advance; the pulled echo does", async () => {
    const rig = makeRig();
    rig.conn.advanceCursorOnAccept = false;
    await rig.queue.enqueue(
      change({ operationId: "op-http", path: "a.md", operation: "update", payload: toBase64(new TextEncoder().encode("v2")) }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    rig.conn.handlers.onAccepted("op-http", 8);
    await new Promise((r) => setTimeout(r, 10));
    // The accept alone never moved the cursor; the queue emptied though.
    expect(rig.queue.size()).toBe(0);
    expect(rig.state.lastRevision).toBe(3);
    // Next poll pulls back the pusher's own change and applies it: cursor moves.
    const echo: Change = change({
      operationId: "op-http",
      revision: 8,
      path: "a.md",
      operation: "update",
      baseRevision: 0,
      payload: toBase64(new TextEncoder().encode("v2")),
    });
    let served = false;
    (rig.conn as unknown as FakeConnection & { pullOverride?: unknown }).pull = async () => {
      if (served) return { currentRevision: 8, resyncRequired: false, changes: [] };
      served = true;
      return { currentRevision: 8, resyncRequired: false, changes: [echo] };
    };
    const synced2 = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    await synced2;
    expect(rig.state.lastRevision).toBe(8);
    expect(rig.conn.acks).toContain(8);
  });

  it("refreshes a stale content descriptor and sends small files inline", async () => {
    const rig = makeRig();
    const bytes = new TextEncoder().encode("v1").buffer as ArrayBuffer;
    rig.files.set("a.md", new Uint8Array(bytes));
    await rig.queue.enqueue(
      change({
        operationId: "op-chunk",
        path: "a.md",
        operation: "create",
        content: {
          hash: await sha256Hex(new TextEncoder().encode("v1")),
          byteLength: 2,
          chunkCount: 1,
        },
      }),
    );
    // the file changed between capture and flush
    rig.files.set("a.md", new Uint8Array(new TextEncoder().encode("v2").buffer as ArrayBuffer));
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    // small files travel inline as base64 payloads, not as content uploads
    expect(rig.conn.sent[0].content).toBeUndefined();
    expect(new TextDecoder().decode(fromBase64(rig.conn.sent[0].payload!))).toBe("v2");
    rig.conn.handlers.onAccepted("op-chunk", 4);
    await synced;
    expect(rig.queue.size()).toBe(0);
  });

  it("serves uploads from staged snapshots even when the live file is gone, then cleans up", async () => {
    const staging = new MemoryStaging();
    const rig = makeRig({ staging });
    const small = new TextEncoder().encode("hello");
    await staging.save("op-inline", small);
    await rig.engine.enqueueLocal(
      change({
        operationId: "op-inline",
        path: "s.md",
        operation: "create",
        content: {
          hash: await sha256Hex(small),
          byteLength: small.byteLength,
          chunkCount: 1,
        },
      }),
    );
    // No live file exists; the snapshot alone must carry the upload.
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    expect(rig.conn.sent[0].content).toBeUndefined();
    expect(new TextDecoder().decode(fromBase64(rig.conn.sent[0].payload!))).toBe("hello");
    rig.conn.handlers.onAccepted("op-inline", 4);
    await synced;
    expect(rig.queue.size()).toBe(0);
    expect(await staging.list()).toEqual([]);
  });

  it("uploads staged snapshots over the 1 MiB inline cap via content references", async () => {
    const staging = new MemoryStaging();
    const rig = makeRig({ staging });
    const big = new Uint8Array(1024 * 1024 + 100).fill(0x41);
    await staging.save("op-big", big);
    await rig.engine.enqueueLocal(
      change({
        operationId: "op-big",
        path: "b.bin",
        operation: "create",
        content: {
          hash: await sha256Hex(big),
          byteLength: big.byteLength,
          chunkCount: 1,
        },
      }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    expect(rig.conn.sent[0].content?.byteLength).toBe(big.byteLength);
    expect(rig.conn.sent[0].payload).toBeUndefined();
    rig.conn.handlers.onAccepted("op-big", 5);
    await synced;
    expect(rig.queue.size()).toBe(0);
    expect(await staging.list()).toEqual([]);
  });

  it("reconciles staged snapshots orphaned by a crash between staging and enqueueing", async () => {
    const staging = new MemoryStaging();
    const rig = makeRig({ staging });
    await staging.save("orphan", new TextEncoder().encode("x"));
    const kept = new TextEncoder().encode("y");
    await staging.save("kept", kept);
    await rig.engine.enqueueLocal(
      change({
        operationId: "kept",
        path: "k.md",
        operation: "create",
        content: {
          hash: await sha256Hex(kept),
          byteLength: 1,
          chunkCount: 1,
        },
      }),
    );
    await rig.engine["reconcileStaging"]();
    expect(await staging.list()).toEqual(["kept"]);
  });

  it("drops a queued upload when the file vanished before flush", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(
      change({
        operationId: "op-ghost",
        path: "ghost.md",
        operation: "create",
        content: { hash: "x", byteLength: 1, chunkCount: 1 },
      }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(0);
    expect(rig.queue.size()).toBe(0);
    await synced;
  });

  it("applies a chunked remote change via fetchContent, verifying the hash", async () => {
    const rig = makeRig();
    rig.engine.start();
    const payload = new TextEncoder().encode("# chunked");
    rig.conn.contentByPath.set(
      "chunk.md",
      new Uint8Array(payload.buffer as ArrayBuffer),
    );
    const remote: Change = change({
      operationId: "remote-chunk",
      revision: 9,
      path: "chunk.md",
      operation: "create",
      baseRevision: 0,
      content: {
        hash: await sha256Hex(new TextEncoder().encode("# chunked")),
        byteLength: payload.byteLength,
        chunkCount: 1,
      },
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.writes.length).toBe(1);
    expect(rig.writes[0].path).toBe("chunk.md");
    expect(new TextDecoder().decode(rig.writes[0].bytes)).toBe("# chunked");
    expect(rig.conn.acks).toEqual([9]);
    expect(rig.state.lastRevision).toBe(9);
  });

  it("pauses after repeated failures when chunked content cannot be fetched", async () => {
    const rig = makeRig({ applyStrikeWindowMs: 10 });
    await rig.engine.start();
    const remote: Change = change({
      operationId: "remote-bad",
      revision: 9,
      path: "chunk.md",
      operation: "create",
      baseRevision: 0,
      content: { hash: "deadbeef", byteLength: 7, chunkCount: 1 },
    });
    // a single fetch failure is retried, not fatal
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.engine.status).toBe("syncing");
    expect(rig.engine.isPaused).toBe(false);
    // repeated failures pause once
    for (let i = 0; i < 2; i++) {
      rig.conn.handlers.onRemoteChange(remote);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(rig.engine.status).toBe("paused");
    expect(rig.state.lastRevision).toBe(3);
    expect(rig.conn.acks).toEqual([]);
  });

  it("converges: pulls in batches until both streams are consumed", async () => {
    const rig = makeRig();
    let pulls = 0;
    (rig.conn as unknown as FakeConnection & { pullOverride?: unknown }).pull = async () => {
      pulls += 1;
      if (pulls === 1) {
        return {
          currentRevision: 4,
          resyncRequired: false,
          changes: [
            change({ operationId: "r1", revision: 4, path: "p1.md", operation: "create", payload: toBase64(new TextEncoder().encode("a")) }),
          ],
        };
      }
      return { currentRevision: 4, resyncRequired: false, changes: [] };
    };
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    await synced;
    expect(pulls).toBeGreaterThanOrEqual(2);
    expect(rig.writes.length).toBe(1);
    expect(rig.state.lastRevision).toBe(4);
  });

  it("enters paused status and keeps the queue when the server demands a resync", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(change({ operationId: "op-1", path: "a.md" }));
    (rig.conn as unknown as FakeConnection & { pullOverride?: unknown }).pull = async () => ({
      currentRevision: 0,
      resyncRequired: true,
      changes: [],
    });
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    await synced;
    expect(rig.engine.status).toBe("paused");
    expect(rig.queue.size()).toBe(1);
  });

  it("wires onResyncRequired from the transport into the paused state", async () => {
    const rig = makeRig();
    await rig.queue.enqueue(change({ operationId: "op-1", path: "a.md" }));
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    rig.conn.handlers.onResyncRequired?.("retention window exceeded");
    await new Promise((r) => setTimeout(r, 10));
    await synced;
    expect(rig.engine.status).toBe("paused");
    expect(rig.queue.size()).toBe(1);
  });

  it("re-applies a redelivered remote change exactly once (journal idempotency)", async () => {
    const rig = makeRig();
    const remote = change({
      operationId: "remote-dupe",
      revision: 4,
      path: "a.md",
      operation: "create",
      payload: toBase64(new TextEncoder().encode("once")),
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.writes.length).toBe(1);
    expect(rig.state.journal.some((e) => e.operationId === "remote-dupe")).toBe(true);
    // lost-ACK redelivery
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.writes.length).toBe(1);
    // same-revision redelivery does not re-ACK (cursor gating)
    expect(rig.conn.acks).toEqual([4]);
  });

  it("treats a rename whose source is gone but target exists as already done", async () => {
    const rig = makeRig();
    rig.files.set("new.md", new Uint8Array(new TextEncoder().encode("x").buffer as ArrayBuffer));
    const remote = change({
      operationId: "remote-rn-2",
      revision: 6,
      path: "new.md",
      oldPath: "old.md",
      operation: "rename",
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.renames).toEqual([]);
    expect(rig.state.journal.some((e) => e.operationId === "remote-rn-2")).toBe(true);
    // the journaled op is proven on any later redelivery
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.renames).toEqual([]);
    // same-revision redelivery does not re-ACK (cursor gating)
    expect(rig.conn.acks).toEqual([6]);
  });

  it("pauses after repeated failures on an ambiguous rename, never ACKing", async () => {
    const rig = makeRig({ applyStrikeWindowMs: 10 });
    const remote = change({
      operationId: "remote-rn-3",
      revision: 6,
      path: "new.md",
      oldPath: "old.md",
      operation: "rename",
    });
    // a single ambiguous rename retries instead of killing sync
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.engine.status).toBe("syncing");
    expect(rig.engine.isPaused).toBe(false);
    // repeated failures pause once, never ACKing
    for (let i = 0; i < 2; i++) {
      rig.conn.handlers.onRemoteChange(remote);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(rig.engine.status).toBe("paused");
    expect(rig.engine.isPaused).toBe(true);
    expect(rig.conn.acks).toEqual([]);
    expect(rig.state.lastRevision).toBe(3);
  });

  it("removes an occupied rename target (last-write-wins) instead of preserving it", async () => {
    const rig = makeRig();
    rig.files.set("src.md", new Uint8Array(new TextEncoder().encode("src").buffer as ArrayBuffer));
    rig.files.set("dst.md", new Uint8Array(new TextEncoder().encode("local dst").buffer as ArrayBuffer));
    const remote = change({
      operationId: "remote-rn-4",
      revision: 7,
      path: "dst.md",
      oldPath: "src.md",
      operation: "rename",
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    // the occupied destination is deleted, then the rename applies cleanly
    expect(rig.removes).toEqual(["dst.md"]);
    expect(rig.renames).toEqual([{ oldPath: "src.md", newPath: "dst.md" }]);
    // no conflict copy is created or queued
    expect(rig.queue.size()).toBe(0);
    expect(rig.conn.acks).toEqual([7]);
  });

  it("renames case-only files through a two-step temp name", async () => {
    const rig = makeRig();
    rig.files.set("Readme.md", new Uint8Array(new TextEncoder().encode("x").buffer as ArrayBuffer));
    const remote = change({
      operationId: "remote-case",
      revision: 8,
      path: "readme.md",
      oldPath: "Readme.md",
      operation: "rename",
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.renames.length).toBe(2);
    expect(rig.renames[0].oldPath).toBe("Readme.md");
    expect(rig.renames[0].newPath).toMatch(/^\.Readme-syncvault-[0-9a-f]{8}\.md$/);
    expect(rig.renames[1]).toEqual({ oldPath: rig.renames[0].newPath, newPath: "readme.md" });
    expect(rig.conn.acks).toEqual([8]);
  });

  it("removes a file blocking a remote folder path (last-write-wins)", async () => {
    const rig = makeRig();
    rig.files.set("dir", new Uint8Array(new TextEncoder().encode("oops").buffer as ArrayBuffer));
    const remote = change({
      operationId: "remote-folder",
      revision: 9,
      path: "dir/note.md",
      operation: "create",
      payload: toBase64(new TextEncoder().encode("nested")),
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    // the blocking file is deleted, then the nested write lands
    expect(rig.removes).toEqual(["dir"]);
    expect(rig.writes.length).toBe(1);
    expect(rig.writes[0].path).toBe("dir/note.md");
    // no backup copy is queued for upload
    expect(rig.queue.size()).toBe(0);
    expect(rig.conn.acks).toEqual([9]);
  });

  it("migrates legacy inline payloads into staged snapshots on start", async () => {
    const staging = new MemoryStaging();
    const rig = makeRig({ staging });
    await rig.queue.enqueue(
      change({
        operationId: "op-legacy-1",
        path: "legacy.md",
        operation: "create",
        payload: toBase64(new TextEncoder().encode("legacy bytes")),
      }),
    );
    await rig.queue.enqueue(
      change({
        operationId: "op-legacy-0",
        path: "empty.md",
        operation: "create",
        payload: "",
      }),
    );
    await rig.engine["migrateLegacyPayloads"]();
    const migrated = rig.queue.items.find((c) => c.operationId === "op-legacy-1")!;
    expect(migrated.payload).toBeUndefined();
    expect(migrated.stagedFile).toBe("op-legacy-1");
    expect(migrated.content?.byteLength).toBe(12);
    expect(new TextDecoder().decode((await staging.load("op-legacy-1"))!)).toBe("legacy bytes");
    // zero-byte files keep their marker payload
    const empty = rig.queue.items.find((c) => c.operationId === "op-legacy-0")!;
    expect(empty.payload).toBe("");
    expect(empty.stagedFile).toBeUndefined();
  });

  it("serves legacy-migrated items as inline payloads on flush", async () => {
    const staging = new MemoryStaging();
    const rig = makeRig({ staging });
    await rig.queue.enqueue(
      change({
        operationId: "op-legacy-2",
        path: "legacy2.md",
        operation: "create",
        payload: toBase64(new TextEncoder().encode("still here")),
      }),
    );
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.conn.sent.length).toBe(1);
    expect(new TextDecoder().decode(fromBase64(rig.conn.sent[0].payload!))).toBe("still here");
    rig.conn.handlers.onAccepted("op-legacy-2", 10);
    await synced;
    expect(await staging.list()).toEqual([]);
  });

  it("pauses only after three consecutive auth failures, then recovers via authRecovered()", async () => {
    const { conn, engine } = makeRig();
    conn.handlers.onAuthFailure?.("bad token");
    expect(engine.isPaused).toBe(false);
    expect(engine.status).not.toBe("paused");
    conn.handlers.onAuthFailure?.("bad token");
    expect(engine.isPaused).toBe(false);
    // third strike pauses once
    conn.handlers.onAuthFailure?.("bad token");
    expect(engine.isPaused).toBe(true);
    expect(engine.status).toBe("paused");
    // a successful reconnect (transport re-linked, like the real UI flow)
    // resets the strike counter and resumes polling
    conn.connected = true;
    await engine.authRecovered();
    expect(engine.isPaused).toBe(false);
    expect(engine.status).toBe("synced");
  });

  it("reconnect rotates the device token and preserves cursor and queue", async () => {
    const state = makeConfiguredState();
    const queue = new ChangeQueue(state);
    await queue.enqueue(
      change({ operationId: "op-reconn", path: "kept.md", operation: "create", payload: "aGk=" }),
    );
    const client = {
      registerDevice: async () => ({ deviceToken: "rotated-token" }),
    } as unknown as SyncClient;
    const auth = new AuthManager(state, client);
    await auth.reconnect("correct horse");
    expect(state.deviceToken).toBe("rotated-token");
    expect(state.lastRevision).toBe(3);
    expect(state.pendingChanges).toHaveLength(1);
    expect(state.pendingChanges[0].operationId).toBe("op-reconn");
  });

  it("retries a transient apply failure instead of pausing, then recovers", async () => {
    const rig = makeRig({ applyStrikeWindowMs: 10 });
    let fail = true;
    rig.vault.write = async (path, bytes) => {
      if (fail) {
        fail = false;
        throw new Error("transient write error");
      }
      rig.watcher.track({ kind: "modify", path });
      rig.writes.push({ path, bytes });
    };
    const remote = change({
      operationId: "remote-retry",
      revision: 4,
      path: "r.md",
      operation: "create",
      baseRevision: 0,
      payload: toBase64(new TextEncoder().encode("x")),
    });
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    // first attempt fails: sync stays live (syncing status), cursor untouched
    expect(rig.writes.length).toBe(0);
    expect(rig.engine.status).toBe("syncing");
    expect(rig.engine.isPaused).toBe(false);
    expect(rig.state.lastRevision).toBe(3);
    // the change is redelivered on the next pull and now succeeds
    rig.conn.handlers.onRemoteChange(remote);
    await new Promise((r) => setTimeout(r, 10));
    expect(rig.writes.length).toBe(1);
    expect(rig.state.lastRevision).toBe(4);
    expect(rig.conn.acks).toEqual([4]);
  });

  it("pauses only after three spaced apply failures", async () => {
    const rig = makeRig({ applyStrikeWindowMs: 10 });
    rig.vault.write = async () => {
      throw new Error("disk full");
    };
    const remote = change({
      operationId: "remote-stuck",
      revision: 4,
      path: "s.md",
      operation: "create",
      baseRevision: 0,
      payload: toBase64(new TextEncoder().encode("x")),
    });
    for (let i = 0; i < 3; i++) {
      rig.conn.handlers.onRemoteChange(remote);
      await new Promise((r) => setTimeout(r, 15));
      if (i < 2) {
        expect(rig.engine.isPaused).toBe(false);
      }
    }
    expect(rig.engine.isPaused).toBe(true);
    expect(rig.engine.status).toBe("paused");
    expect(rig.state.lastRevision).toBe(3);
  });

  it("counts rapid retries of the same failure as a single strike", async () => {
    const rig = makeRig({ applyStrikeWindowMs: 5000 });
    rig.vault.write = async () => {
      throw new Error("flaky");
    };
    const remote = change({
      operationId: "remote-flaky",
      revision: 4,
      path: "f.md",
      operation: "create",
      baseRevision: 0,
      payload: toBase64(new TextEncoder().encode("x")),
    });
    for (let i = 0; i < 5; i++) {
      rig.conn.handlers.onRemoteChange(remote);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(rig.engine.isPaused).toBe(false);
  });

  it("resets the auth strike counter on any authenticated success", async () => {
    const rig = makeRig();
    rig.conn.handlers.onAuthFailure?.("bad token");
    rig.conn.handlers.onAuthFailure?.("bad token");
    rig.conn.handlers.onAuthed?.();
    rig.conn.handlers.onAuthFailure?.("bad token");
    rig.conn.handlers.onAuthFailure?.("bad token");
    // 2 failures, reset, 2 failures — never three consecutive
    expect(rig.engine.isPaused).toBe(false);
  });

  it("a stop during an in-flight pull prevents the old run from applying", async () => {
    const rig = makeRig();
    let resolvePull!: (v: { currentRevision: number; changes: Change[]; resyncRequired: boolean }) => void;
    (rig.conn as unknown as FakeConnection & { pullOverride?: unknown }).pull = () =>
      new Promise((res) => {
        resolvePull = res;
      });
    const remote = change({
      operationId: "remote-late",
      revision: 9,
      path: "late.md",
      operation: "create",
      baseRevision: 0,
      payload: toBase64(new TextEncoder().encode("x")),
    });
    const synced = rig.engine.syncNow();
    await new Promise((r) => setTimeout(r, 10));
    rig.engine.stop();
    resolvePull!({ currentRevision: 9, changes: [remote], resyncRequired: false });
    await synced;
    // the stale run must not touch the filesystem, cursor, queue or status
    expect(rig.writes.length).toBe(0);
    expect(rig.state.lastRevision).toBe(3);
    expect(rig.queue.size()).toBe(0);
    expect(rig.engine.status).toBe("idle");
  });

  it("enqueues visual appearance files inline, staged, or as zero-byte payloads", async () => {
    const staging = new MemoryStaging();
    const rig = makeRig({ staging });
    const small = new TextEncoder().encode('{"cssTheme":"Atom"}') as Uint8Array<ArrayBuffer>;
    const big = new Uint8Array<ArrayBuffer>(2 * 1024 * 1024).fill(7);

    await rig.engine.enqueueVisualChange("syncvault-visual/appearance.json", small);
    await rig.engine.enqueueVisualChange("syncvault-visual/themes/Big/theme.css", big);
    await rig.engine.enqueueVisualChange("syncvault-visual/empty.md", new Uint8Array<ArrayBuffer>(0));

    expect(rig.queue.items.map((c) => c.path)).toEqual([
      "syncvault-visual/appearance.json",
      "syncvault-visual/themes/Big/theme.css",
      "syncvault-visual/empty.md",
    ]);
    const smallItem = rig.queue.items.find((c) => c.path.endsWith("appearance.json"))!;
    expect(typeof smallItem.payload).toBe("string");
    const bigItem = rig.queue.items.find((c) => c.path.includes("theme.css"))!;
    expect(bigItem.content?.byteLength).toBe(big.byteLength);
    expect(bigItem.stagedFile).toBe(bigItem.operationId);
    const empty = rig.queue.items.find((c) => c.path.endsWith("empty.md"))!;
    expect(empty.payload).toBe("");
  });

  it("counts syncable files for recovery safety checks", async () => {
    const rig = makeRig({
      scanner: {
        listFiles: async () => [
          { path: "a.md", size: 10 },
          { path: ".obsidian/appearance.json", size: 5 },
          { path: "big.bin", size: 30 * 1024 * 1024 },
          { path: "empty.md", size: 0 },
        ],
        readBytes: async () => new ArrayBuffer(0),
      },
    });
    expect(await rig.engine.countSyncableFiles()).toBe(1);
  });

  it("two devices: a file created on A appears on B (capture → push → pull → apply)", async () => {
    const server = new FakeServer();
    const a = makeDevice(server, "dev-a", 0);
    const b = makeDevice(server, "dev-b", 0);

    // Device A: user creates a note. The watcher debounce captures it and the
    // engine pushes it immediately (scheduleImmediateSync — no manual wait).
    a.files.set("note.md", new TextEncoder().encode("# from A"));
    a.watcher.track({ kind: "create", path: "note.md" });
    await a.watcher.flush();
    await new Promise((r) => setTimeout(r, 80)); // immediate-sync kick
    expect(server.changes).toHaveLength(1);
    expect(a.queue.size()).toBe(0);

    // Device B: the next poll pulls the revision and applies it.
    await b.engine.syncNow();
    expect(b.writes.length).toBe(1);
    expect(b.writes[0].path).toBe("note.md");
    expect(new TextDecoder().decode(b.writes[0].bytes)).toBe("# from A");
    expect(b.state.lastRevision).toBe(1);
    expect(b.queue.size()).toBe(0); // no echo change from the applied write
  });

  it("two devices: edits and creates propagate in both directions", async () => {
    const server = new FakeServer();
    const a = makeDevice(server, "dev-a", 0);
    const b = makeDevice(server, "dev-b", 0);

    // B creates a file first.
    b.files.set("b-note.md", new TextEncoder().encode("# from B"));
    b.watcher.track({ kind: "create", path: "b-note.md" });
    await b.watcher.flush();
    await b.engine.syncNow();

    // A pulls it.
    await a.engine.syncNow();
    expect(a.writes.some((w) => w.path === "b-note.md")).toBe(true);

    // A edits it; B must receive the update.
    a.files.set("b-note.md", new TextEncoder().encode("# from B, edited on A"));
    a.watcher.track({ kind: "modify", path: "b-note.md" });
    await a.watcher.flush();
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.writes.some((w) => new TextDecoder().decode(w.bytes) === "# from B, edited on A")).toBe(true);
    expect(b.state.lastRevision).toBe(server.changes.length);
  });

  it("two devices: an empty file created on A reaches B as a zero-byte file", async () => {
    const server = new FakeServer();
    const a = makeDevice(server, "dev-a", 0);
    const b = makeDevice(server, "dev-b", 0);

    a.files.set("empty.md", new Uint8Array(0));
    a.watcher.track({ kind: "create", path: "empty.md" });
    await a.watcher.flush();
    await a.engine.syncNow();
    await b.engine.syncNow();

    expect(b.writes.length).toBe(1);
    expect(b.writes[0].path).toBe("empty.md");
    expect(b.writes[0].bytes.byteLength).toBe(0);
  });
});

/** Minimal shared server state for two-device integration tests: accepts
 * changes in order (with per-operation receipts) and serves pulls after a
 * cursor, mirroring the worker's revision semantics. */
class FakeServer {
  changes: Change[] = [];
  private revision = 1;
  private receipts = new Map<string, number>();

  submit(c: Change, deviceId: string): { status: "accepted"; revision: number } {
    const receipt = this.receipts.get(c.operationId);
    if (receipt !== undefined) return { status: "accepted", revision: receipt };
    const rev = this.revision++;
    this.changes.push({ ...c, revision: rev, deviceId });
    this.receipts.set(c.operationId, rev);
    return { status: "accepted", revision: rev };
  }

  pull(since: number): Change[] {
    return this.changes.filter((c) => c.revision > since);
  }
}

/** HTTP-like transport for a device: pushes hit the shared server; pull
 * returns everything after the device cursor. */
class FakeServerConnection implements Connection {
  connected = true;
  advanceCursorOnAccept = false;
  handlers: ConnectionCallbacks;

  constructor(
    private server: FakeServer,
    private deviceId: string,
    private getCursor: () => number,
    handlers: ConnectionCallbacks,
  ) {
    this.handlers = handlers;
  }

  connect(): void {}
  disconnect(): void {
    this.connected = false;
  }

  sendChange(c: Change): boolean {
    const result = this.server.submit(c, this.deviceId);
    this.handlers.onAccepted(c.operationId, result.revision);
    return true;
  }

  sendAck(): boolean {
    return true;
  }

  async fetchContent(c: Change): Promise<Uint8Array<ArrayBuffer> | null> {
    return c.payload !== undefined ? fromBase64(c.payload) : null;
  }

  async pull(): Promise<{ currentRevision: number; changes: Change[]; resyncRequired: boolean }> {
    return { currentRevision: 0, changes: this.server.pull(this.getCursor()), resyncRequired: false };
  }
}

interface Device {
  state: SyncState;
  queue: ChangeQueue;
  watcher: VaultWatcher;
  engine: SyncEngine;
  files: Map<string, Uint8Array<ArrayBuffer>>;
  writes: { path: string; bytes: Uint8Array }[];
}

/** A fully-wired device: vault stub + watcher (like the plugin's main.ts) +
 * engine on the shared server transport. */
function makeDevice(server: FakeServer, deviceId: string, lastRevision: number): Device {
  const backend: SyncStateBackend = { load: async () => undefined, save: async () => undefined };
  const state = new SyncState(backend);
  state.save({
    accountId: "acc",
    vaultId: "vault",
    deviceId,
    deviceToken: "tok",
    lastRevision,
  });
  const queue = new ChangeQueue(state);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const writes: { path: string; bytes: Uint8Array }[] = [];
  let engine!: SyncEngine;
  const watcher = new VaultWatcher({
    readBytes: async (path) => {
      const file = files.get(path);
      return file === undefined ? null : (file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
    },
    getBaseRevision: () => state.lastRevision,
    // Mirrors main.ts: captures flow through the engine so a live edit kicks
    // an immediate sync round instead of waiting for the next poll.
    onChange: (c) => engine.enqueueLocal(c),
  });
  const vault: VaultOps = {
    write: async (path, bytes) => {
      watcher.track({ kind: "modify", path });
      writes.push({ path, bytes });
      files.set(path, new Uint8Array(bytes));
    },
    remove: async (path) => {
      watcher.track({ kind: "delete", path });
      files.delete(path);
    },
    rename: async (oldPath, newPath) => {
      watcher.track({ kind: "rename", path: newPath, oldPath });
      const bytes = files.get(oldPath);
      files.set(newPath, bytes ?? new Uint8Array(0));
      files.delete(oldPath);
    },
    readFile: async (path) => files.get(path) ?? null,
    stat: async (path) => (files.has(path) ? "file" : null),
  };
  engine = new SyncEngine(state, queue, watcher, vault, () => undefined, () => undefined, {
    connectionFactory: (handlers) =>
      new FakeServerConnection(server, deviceId, () => state.lastRevision, handlers),
  });
  return { state, queue, watcher, engine, files, writes };
}

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