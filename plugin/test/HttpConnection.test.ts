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
      onConflict: () => undefined,
      onError: () => undefined,
    } as ConnectionCallbacks);
    conn.sendChange(change());
    await new Promise((r) => setTimeout(r, 20));
    expect(accepted).toEqual({ operationId: "op-1", revision: 9 });
  });

  it("resolves conflict via the onConflict callback", async () => {
    let conflict: { operationId: string; conflictPath?: string } | null = null;
    const client = makeClient({
      pushChange: async () => ({ status: "conflict" as const, path: "a.md", conflictPath: "a (conflict).md", serverRevision: 9 }),
    });
    const conn = new HttpConnection(makeState(), client, {
      onConflict: (c) => (conflict = { operationId: c.operationId, conflictPath: c.conflictPath }),
      onError: () => undefined,
    } as ConnectionCallbacks);
    conn.sendChange(change());
    await new Promise((r) => setTimeout(r, 20));
    expect(conflict).toEqual({ operationId: "op-1", conflictPath: "a (conflict).md" });
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
});