import { describe, expect, it } from "vitest";
import { SyncState, SyncStateBackend, SyncVaultData } from "../src/state/SyncState";

function backendWith(value: Partial<SyncVaultData>): SyncStateBackend {
  return {
    load: async () => value,
    save: async () => undefined,
  };
}

describe("SyncState", () => {
  it("quarantines malformed persisted queue entries", async () => {
    const state = new SyncState(
      backendWith({
        lastRevision: -1,
        pendingChanges: [
          {
            operationId: "valid",
            revision: 0,
            deviceId: "",
            path: "note.md",
            operation: "create",
            baseRevision: 0,
            timestamp: Date.now(),
            payload: "aGk=",
            attempts: 0,
          },
          { operationId: "bad", path: "../escape.md" },
          { operationId: "bad-payload", path: "bad.md", operation: "create", payload: "%%%" },
        ],
        appliedPaths: ["good.md", "../bad.md"],
      }),
    );
    await state.load();
    expect(state.lastRevision).toBe(0);
    expect(state.pendingChanges.map((change) => change.operationId)).toEqual(["valid"]);
    expect(state.hasApplied("good.md")).toBe(true);
    expect(state.hasApplied("../bad.md")).toBe(false);
  });

  it("clears queued changes when disconnecting", async () => {
    const state = new SyncState({ load: async () => undefined, save: async () => undefined });
    await state.save({
      accountId: "account",
      vaultId: "vault",
      deviceId: "device",
      deviceToken: "token",
      pendingChanges: [],
    });
    await state.disconnect();
    expect(state.pendingChanges).toEqual([]);
    expect(state.connected).toBe(false);
  });
});
