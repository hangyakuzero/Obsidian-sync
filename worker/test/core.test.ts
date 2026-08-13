import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Change } from "@syncvault/shared";

const PASSWORD = "correct horse battery staple";

async function createAccount(accountId: string): Promise<void> {
  const res = await SELF.fetch("http://localhost/v1/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD }),
  });
  expect(res.status).toBe(201);
}

async function createVault(accountId: string, name: string): Promise<string> {
  const res = await SELF.fetch("http://localhost/v1/vaults", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, name }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ vaultId: string }>()).vaultId;
}

async function registerDevice(accountId: string, vaultId: string, deviceId: string): Promise<string> {
  const res = await SELF.fetch(`http://localhost/v1/vaults/${vaultId}/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, deviceId, name: "test" }),
  });
  expect(res.status).toBe(201);
  return (await res.json<{ deviceToken: string }>()).deviceToken;
}

function change(over: Partial<Change>): Change {
  return {
    operationId: `op-${Math.random()}`,
    revision: 0,
    deviceId: "dev-test-0001",
    path: "a.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    payload: "b64",
    ...over,
  };
}

describe("health", () => {
  it("returns ok", async () => {
    const res = await SELF.fetch("http://localhost/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "syncvault" });
  });
});

describe("accounts", () => {
  it("creates, rejects duplicates, logs in with correct/incorrect password", async () => {
    await createAccount("alice");
    // duplicate -> conflict
    const dup = await SELF.fetch("http://localhost/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "alice", password: PASSWORD }),
    });
    expect(dup.status).toBe(409);
    // bad account ids rejected
    const bad = await SELF.fetch("http://localhost/v1/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "UPPER", password: PASSWORD }),
    });
    expect(bad.status).toBe(400);

    const ok = await SELF.fetch("http://localhost/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "alice", password: PASSWORD }),
    });
    expect(ok.status).toBe(200);
    const badPw = await SELF.fetch("http://localhost/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "alice", password: "wrong" }),
    });
    expect(badPw.status).toBe(401);
    // unknown username is distinguishable from a rejected password
    const ghost = await SELF.fetch("http://localhost/v1/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "ghost-user", password: PASSWORD }),
    });
    expect(ghost.status).toBe(404);
    expect((await ghost.json<{ error: string }>()).error).toBe("NOT_FOUND");
  });
});

describe("vaults and devices", () => {
  it("creates vault, registers device, lists vaults via device token", async () => {
    await createAccount("bob");
    const vaultId = await createVault("bob", "My Notes");
    const token = await registerDevice("bob", vaultId, "dev-test-0001");

    const list = await SELF.fetch("http://localhost/v1/vaults", {
      headers: { Authorization: `Bearer bob:dev-test-0001:${token}` },
    });
    expect(list.status).toBe(200);
    const body = await list.json<{ vaults: { vaultId: string; name: string }[] }>();
    expect(body.vaults).toEqual([{ vaultId, name: "My Notes" }]);

    // wrong token rejected
    const bad = await SELF.fetch("http://localhost/v1/vaults", {
      headers: { Authorization: `Bearer bob:dev-test-0001:deadbeef` },
    });
    expect(bad.status).toBe(401);

    // password-based listing (existing-user flow for an unregistered device)
    const byPassword = await SELF.fetch("http://localhost/v1/vaults/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "bob", password: PASSWORD }),
    });
    expect(byPassword.status).toBe(200);
    const pwBody = await byPassword.json<{ vaults: { vaultId: string; name: string }[] }>();
    expect(pwBody.vaults).toContainEqual({ vaultId, name: "My Notes" });
    const pwBad = await SELF.fetch("http://localhost/v1/vaults/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "bob", password: "nope" }),
    });
    expect(pwBad.status).toBe(401);

    // account A cannot register into a vault of account B
    const vaultA = await createVault("bob", "Secret");
    const res = await SELF.fetch(`http://localhost/v1/vaults/${vaultA}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "alice", password: PASSWORD, deviceId: "dev-test-0002", name: "x" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("vault sync core", () => {
  it("serializes mutations, detects conflicts, keeps operation receipts", async () => {
    await createAccount("carol");
    const vaultId = await createVault("carol", "DSA");
    const stub = env.VAULT_DO.getByName(vaultId);
    const deviceId = "dev-test-0001";

    // create a.md
    const created = await stub.submitChange(
      change({ operationId: "op-1", path: "a.md", operation: "create", baseRevision: 0, payload: "aGVsbG8=", deviceId }),
      deviceId,
    );
    expect(created).toEqual({ status: "accepted", revision: 1 });

    // duplicate operationId is idempotent
    const dup = await stub.submitChange(
      change({ operationId: "op-1", path: "a.md", operation: "create", baseRevision: 0, payload: "aGVsbG8=", deviceId }),
      deviceId,
    );
    expect(dup).toEqual({ status: "accepted", revision: 1 });

    // honest update: base revision 1 -> accepted, revision 2
    const updated = await stub.submitChange(
      change({ operationId: "op-2", path: "a.md", operation: "update", baseRevision: 1, payload: "d29ybGQ=", deviceId }),
      deviceId,
    );
    expect(updated).toEqual({ status: "accepted", revision: 2 });

    // stale update (base 1 but path is at revision 2) -> conflict, copy committed
    const conflicted = await stub.submitChange(
      change({ operationId: "op-3", path: "a.md", operation: "update", baseRevision: 1, payload: "c3RhbGU=", deviceId }),
      deviceId,
    );
    expect(conflicted.status).toBe("conflict");
    if (conflicted.status !== "conflict") throw new Error("expected conflict");
    expect(conflicted.serverRevision).toBe(2);
    expect(conflicted.conflictPath).toContain("a (conflict-");
    const conflictPath = conflicted.conflictPath as string;
    expect(conflictPath.endsWith(".md")).toBe(true);

    // retry of the conflicted operation resolves via receipt -> accepted
    const retried = await stub.submitChange(
      change({ operationId: "op-3", path: "a.md", operation: "update", baseRevision: 1, payload: "c3RhbGU=", deviceId }),
      deviceId,
    );
    expect(retried.status).toBe("accepted");

    // change log reflects only the committed mutations
    const log = await stub.changesAfter(0);
    expect(log.map((c) => `${c.revision}:${c.path}`)).toEqual([
      "1:a.md",
      "2:a.md",
      `3:${conflictPath}`,
    ]);

    // malicious payload too large
    await expect(
      stub.submitChange(
        change({ operationId: "op-4", path: "b.md", operation: "create", baseRevision: 0, payload: "b".repeat(24e6), deviceId }),
        deviceId,
      ),
    ).rejects.toThrow(/exceeds inline size limit/);
  });

  it("rejects payload-less create/update changes", async () => {
    await createAccount("erin");
    const vaultId = await createVault("erin", "V");
    const stub = env.VAULT_DO.getByName(vaultId);
    await expect(
      stub.submitChange(
        change({ operationId: "op-empty", path: "empty.md", operation: "create", payload: undefined }),
        "dev-test-0001",
      ),
    ).rejects.toThrow(/file content required/);
    await expect(
      stub.submitChange(
        change({ operationId: "op-empty-upd", path: "empty.md", operation: "update", payload: undefined }),
        "dev-test-0001",
      ),
    ).rejects.toThrow(/file content required/);
  });

  it("rejects changes forged under another device id and bad paths", async () => {
    await createAccount("dan");
    const vaultId = await createVault("dan", "V");
    const stub = env.VAULT_DO.getByName(vaultId);
    await expect(
      stub.submitChange(change({ deviceId: "dev-test-0001" }), "dev-test-0002"),
    ).rejects.toThrow(/does not match/);
    await expect(
      stub.submitChange(change({ path: "../escape.md" }), "dev-test-0001"),
    ).rejects.toThrow(/invalid path/);
  });
});