import { describe, expect, it } from "vitest";
import { HttpConnection } from "../src/sync/HttpConnection";
import { ConnectionCallbacks } from "../src/sync/SyncConnection";
import { SyncState, SyncStateBackend } from "../src/state/SyncState";
import type { SyncClient } from "../src/api/SyncClient";
import type { Change } from "@syncvault/shared";

const PUSH_RESULT_ACCEPTED = { status: "accepted" as const, revision: 9 };

function makeClient(over: Partial<SyncClient> = {}): SyncClient {
  return {
    pullChanges: async () => ({ currentRevision: 9, minRetainedRevision: 1, resyncRequired: false, changes: [] }),
    pushChange: async () => PUSH_RESULT_ACCEPTED,
    sendAck: async () => undefined,
    ...over,
  } as unknown as SyncClient;
}

function makeState(): SyncState {
  const backend: SyncStateBackend = { load: async () => undefined, save: async () => undefined };
  const state = new SyncState(backend);
  void state.load();
  void state.save({
    accountId: "acc",
    vaultId: "vault",
    deviceId: "dev-0001",
    deviceToken: "tok",
    lastRevision: 5,
  });
  return state;
}

function change(over: Partial<Change> = {}): Change {
  return {
    operationId: "op-1",
    revision: 0,
    deviceId: "dev-0001",
    path: "a.md",
    operation: "create",
    baseRevision: 5,
    timestamp: Date.now(),
    payload: "aGk=",
    ...over,
  };
}

function apiError(status: number, code: string, message: string): Error {
  const err = new Error(message) as Error & { status?: number; code?: string };
  err.status = status;
  err.code = code;
  return err;
}

describe("HttpConnection", () => {
  it("pulls changes after the cursor and reports resync", async () => {
    const seen: number[] = [];
    const client = makeClient({
      pullChanges: async (_a, _v, _d, _t, since) => {
        seen.push(since);
        return { currentRevision: 7, minRetainedRevision: 2, resyncRequired: false, changes: [] };
      },
    });
    const conn = new HttpConnection(makeState(), client, {} as ConnectionCallbacks);
    const result = await conn.pull(5);
    expect(seen).toEqual([5]);
    expect(result.currentRevision).toBe(7);
  });

  it("resolves accepted via the onAccepted callback", async () => {
    let accepted: { operationId: string; revision: number } | null = null;
    const conn = new HttpConnection(makeState(), makeClient(), {
      onAccepted: (operationId, revision) => (accepted = { operationId, revision }),
      onError: () => undefined,
    } as ConnectionCallbacks);
    conn.sendChange(change());
    await new Promise((r) => setTimeout(r, 20));
    expect(accepted).toEqual({ operationId: "op-1", revision: 9 });
  });

  it("accepts a push with a stale base revision (last-write-wins)", async () => {
    let accepted: { operationId: string; revision: number } | null = null;
    const conn = new HttpConnection(makeState(), makeClient(), {
      onAccepted: (operationId, revision) => (accepted = { operationId, revision }),
      onError: () => undefined,
    } as ConnectionCallbacks);
    // A client that fell behind the server still gets its upload accepted;
    // there is no conflict response to fall back on.
    conn.sendChange(change({ baseRevision: 2 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(accepted).toEqual({ operationId: "op-1", revision: 9 });
  });

  it("reports push failures on the error callback", async () => {
    const errors: string[] = [];
    const client = makeClient({
      pushChange: async () => {
        throw new Error("network down");
      },
    });
    const conn = new HttpConnection(makeState(), client, {
      onError: (m) => errors.push(m),
    } as ConnectionCallbacks);
    conn.sendChange(change());
    await new Promise((r) => setTimeout(r, 20));
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("network down");
  });

  it("maps a 460 push to onResyncRequired instead of dropping the change", async () => {
    const resync: string[] = [];
    const rejected: string[] = [];
    const client = makeClient({
      pushChange: async () => {
        throw apiError(460, "RESYNC_REQUIRED", "vault history was reset; resync required");
      },
    });
    const conn = new HttpConnection(makeState(), client, {
      onResyncRequired: () => resync.push("resync"),
      onRejected: (id) => rejected.push(id),
    } as ConnectionCallbacks);
    conn.sendChange(change());
    await new Promise((r) => setTimeout(r, 20));
    expect(resync.length).toBe(1);
    expect(rejected.length).toBe(0);
  });

  it("reports resyncRequired from the pull response", async () => {
    const resync: number[] = [];
    const client = makeClient({
      pullChanges: async () => ({
        currentRevision: 7,
        minRetainedRevision: 2,
        resyncRequired: true,
        changes: [],
      }),
    });
    const conn = new HttpConnection(makeState(), client, {
      onResyncRequired: () => resync.push(1),
    } as ConnectionCallbacks);
    const result = await conn.pull(5);
    expect(result.resyncRequired).toBe(true);
    expect(resync.length).toBe(1);
  });

  it("maps a 426 pull to onError and rethrows", async () => {
    const errors: string[] = [];
    const client = makeClient({
      pullChanges: async () => {
        throw apiError(426, "CLIENT_UPGRADE_REQUIRED", "this vault contains chunked content; update SyncVault");
      },
    });
    const conn = new HttpConnection(makeState(), client, {
      onError: (m) => errors.push(m),
    } as ConnectionCallbacks);
    await expect(conn.pull(5)).rejects.toThrow();
    expect(errors.length).toBe(1);
  });

  it("notifies onAuthed after a successful pull and push accept", async () => {
    let authed = 0;
    const client = makeClient({
      downloadContent: async () => new Uint8Array([1, 2, 3]),
    });
    const conn = new HttpConnection(makeState(), client, {
      onAuthed: () => (authed += 1),
    } as ConnectionCallbacks);
    await conn.pull(5);
    conn.sendChange(change());
    await new Promise((r) => setTimeout(r, 20));
    // pull + push accept = 2 authenticated successes
    expect(authed).toBe(2);
  });

  it("classifies a content-download 401 as an auth failure, not corrupt content", async () => {
    const authErrors: string[] = [];
    const errors: string[] = [];
    const client = makeClient({
      downloadContent: async () => {
        throw apiError(401, "UNAUTHORIZED", "invalid token");
      },
    });
    const conn = new HttpConnection(makeState(), client, {
      onAuthFailure: (m) => authErrors.push(m),
      onError: (m) => errors.push(m),
    } as ConnectionCallbacks);
    const result = await conn.fetchContent(change({ content: { hash: "a".repeat(64), byteLength: 1, chunkCount: 1 }, revision: 9 }));
    expect(result).toBeNull();
    expect(authErrors.length).toBe(1);
    expect(errors.length).toBe(0);
  });

  it("does not classify a non-401 content-download failure as an auth failure", async () => {
    const authErrors: string[] = [];
    const errors: string[] = [];
    const client = makeClient({
      downloadContent: async () => {
        throw new Error("connection reset");
      },
    });
    const conn = new HttpConnection(makeState(), client, {
      onAuthFailure: () => authErrors.push("auth"),
      onError: (m) => errors.push(m),
    } as ConnectionCallbacks);
    const result = await conn.fetchContent(change({ content: { hash: "b".repeat(64), byteLength: 1, chunkCount: 1 }, revision: 9 }));
    expect(result).toBeNull();
    expect(authErrors.length).toBe(0);
    expect(errors.length).toBe(1);
  });
});