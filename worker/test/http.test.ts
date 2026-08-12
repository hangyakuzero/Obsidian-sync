import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Change } from "@syncvault/shared";
import { toBase64 } from "@syncvault/shared";

const PASSWORD = "correct horse battery staple";

interface Setup {
  accountId: string;
  vaultId: string;
  deviceId: string;
  token: string;
}

async function setup(name: string): Promise<Setup> {
  const accountId = name;
  await SELF.fetch("http://localhost/v1/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD }),
  });
  const vaultRes = await SELF.fetch("http://localhost/v1/vaults", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, name: "V" }),
  });
  const { vaultId } = (await vaultRes.json()) as { vaultId: string };
  const deviceId = `${name}-dv-0001`;
  const reg = await SELF.fetch(`http://localhost/v1/vaults/${vaultId}/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, deviceId, name: "x" }),
  });
  const { deviceToken } = (await reg.json()) as { deviceToken: string };
  return { accountId, vaultId, deviceId, token: deviceToken };
}

function auth(t: Setup): string {
  return `Bearer ${t.accountId}:${t.deviceId}:${t.token}`;
}

function change(over: Partial<Change> = {}): Change {
  return {
    operationId: "http-op-1",
    revision: 0,
    deviceId: "",
    path: "hello.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    payload: toBase64(new TextEncoder().encode("# Hello")),
    ...over,
  };
}

describe("HTTP sync endpoints", () => {
  it("push -> sync pull -> ack roundtrip", async () => {
    const t = await setup("httpt1");
    const vault = env.VAULT_DO.getByName(t.vaultId);

    // push a create
    const push = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(change({ deviceId: t.deviceId })),
    });
    expect(push.status).toBe(200);
    expect(await push.json()).toEqual({ status: "accepted", revision: 1 });

    // pull after cursor 0 sees it
    const pull = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/sync?since=0`, {
      headers: { Authorization: auth(t) },
    });
    expect(pull.status).toBe(200);
    const body = (await pull.json()) as {
      currentRevision: number;
      minRetainedRevision: number;
      resyncRequired: boolean;
      changes: Change[];
    };
    expect(body.currentRevision).toBe(1);
    expect(body.resyncRequired).toBe(false);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0]).toMatchObject({ revision: 1, path: "hello.md", operation: "create" });

    // pull after cursor 1 sees nothing
    const pull2 = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/sync?since=1`, {
      headers: { Authorization: auth(t) },
    });
    const body2 = (await pull2.json()) as { changes: Change[] };
    expect(body2.changes).toHaveLength(0);

    // ack advances the device cursor so GC can consume the change
    const ack = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({ revision: 1 }),
    });
    expect(ack.status).toBe(200);
    const status = await vault.status();
    expect(status.devices.find((d) => d.deviceId === t.deviceId)?.lastAckRevision).toBe(1);
  });

  it("rejects unauthenticated or cross-vault access", async () => {
    const t = await setup("httpt2");
    const other = await setup("httpt3");

    const noAuth = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/sync?since=0`);
    expect(noAuth.status).toBe(401);

    const wrongVault = await SELF.fetch(`http://localhost/v1/vaults/${other.vaultId}/sync?since=0`, {
      headers: { Authorization: auth(t) },
    });
    expect(wrongVault.status).toBe(401);
  });

  it("push reports conflicts over HTTP and idempotent retries resolve", async () => {
    const t = await setup("httpt4");
    const vault = env.VAULT_DO.getByName(t.vaultId);

    const push1 = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(change({ operationId: "op-a", deviceId: t.deviceId, path: "a.md" })),
    });
    expect((await push1.json())).toEqual({ status: "accepted", revision: 1 });

    // stale push (base 0, path at 1) -> conflict
    const push2 = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(
        change({ operationId: "op-b", deviceId: t.deviceId, path: "a.md", operation: "update", baseRevision: 0 }),
      ),
    });
    const conflict = (await push2.json()) as { status: string; conflictPath?: string };
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflictPath).toContain("a (conflict-");

    // retry of the same operation resolves idempotently
    const retry = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(
        change({ operationId: "op-b", deviceId: t.deviceId, path: "a.md", operation: "update", baseRevision: 0 }),
      ),
    });
    expect((await retry.json())).toEqual({ status: "accepted", revision: 2 });

    const log = await vault.changesAfter(0);
    expect(log.map((c) => c.operation)).toEqual(["create", "create"]);
  });
});