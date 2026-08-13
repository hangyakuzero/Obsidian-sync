import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Change, ClientMessage, ServerMessage } from "@syncvault/shared";
import { toBase64 } from "@syncvault/shared";

const PASSWORD = "correct horse battery staple";

let opSeq = 1000;
function change(over: Partial<Change>): Change {
  opSeq += 1;
  return {
    operationId: `op-${opSeq}`,
    revision: 0,
    deviceId: "mstest-a-0001",
    path: "a.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    payload: toBase64(new TextEncoder().encode("x")),
    ...over,
  };
}

async function setup(name: string): Promise<{ accountId: string; vaultId: string; tokens: string[] }> {
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
  const tokens: string[] = [];
  for (const deviceId of [`${name}-a-0001`, `${name}-b-0001`]) {
    const reg = await SELF.fetch(`http://localhost/v1/vaults/${vaultId}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, password: PASSWORD, deviceId, name: "x" }),
    });
    tokens.push(((await reg.json()) as { deviceToken: string }).deviceToken);
  }
  return { accountId, vaultId, tokens };
}

async function openWs(accountId: string, vaultId: string, deviceId: string): Promise<WebSocket> {
  const res = await SELF.fetch(
    `http://localhost/v1/vaults/${vaultId}/ws?accountId=${accountId}&deviceId=${deviceId}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

function nextMessage(
  ws: WebSocket,
  predicate: (m: ServerMessage) => boolean,
  timeoutMs = 5000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("timed out waiting for message"));
    }, timeoutMs);
    const handler = (ev: MessageEvent) => {
      let m: ServerMessage;
      try {
        m = JSON.parse((ev.data as string) ?? "") as ServerMessage;
      } catch {
        return;
      }
      if (!predicate(m)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(m);
    };
    ws.addEventListener("message", handler);
  });
}

async function connect(accountId: string, vaultId: string, deviceId: string, token: string): Promise<WebSocket> {
  const ws = await openWs(accountId, vaultId, deviceId);
  const hello: ClientMessage = { type: "hello", accountId, vaultId, deviceId, token, lastRevision: 0 };
  const welcomeP = nextMessage(ws, (m) => m.type === "welcome");
  ws.send(JSON.stringify(hello));
  await welcomeP;
  return ws;
}

describe("mutation semantics", () => {
  it("delete propagates and a stale delete is accepted (last-write-wins)", async () => {
    const t = await setup("mut1");
    const wsA = await connect(t.accountId, t.vaultId, `${t.accountId}-a-0001`, t.tokens[0]);
    const wsB = await connect(t.accountId, t.vaultId, `${t.accountId}-b-0001`, t.tokens[1]);

    // Pre-register B's watchers before A sends anything.
    const created = nextMessage(wsB, (m) => m.type === "change" && (m as { change: Change }).change.operation === "create");
    const deleted = nextMessage(wsB, (m) => m.type === "change" && (m as { change: Change }).change.operation === "delete");

    // A creates, then deletes
    const accCreate = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-a-0001`, path: "gone.md", operation: "create", baseRevision: 0 }) }));
    await accCreate;
    const accDelete = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-a-0001`, path: "gone.md", operation: "delete", baseRevision: 1 }) }));
    await accDelete;

    const c1 = (await created) as Extract<ServerMessage, { type: "change" }>;
    const d1 = (await deleted) as Extract<ServerMessage, { type: "change" }>;
    expect(c1.change.operation).toBe("create");
    expect(d1.change.operation).toBe("delete");
    expect(d1.change.path).toBe("gone.md");

    // stale delete (based on rev 1 while server is at rev 2): accepted — the
    // incoming commit is the latest word; no conflict response exists.
    const accStale = nextMessage(wsB, (m) => m.type === "accepted");
    wsB.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-b-0001`, path: "gone.md", operation: "delete", baseRevision: 1 }) }));
    const stale = (await accStale) as Extract<ServerMessage, { type: "accepted" }>;
    expect(stale.revision).toBe(3);

    const log = await env.VAULT_DO.getByName(t.vaultId).changesAfter(0);
    expect(log.map((c) => c.operation)).toEqual(["create", "delete", "delete"]);
  });

  it("rename propagates; a stale rename onto a changed target is accepted", async () => {
    const t = await setup("mut2");
    const wsA = await connect(t.accountId, t.vaultId, `${t.accountId}-a-0001`, t.tokens[0]);
    const wsB = await connect(t.accountId, t.vaultId, `${t.accountId}-b-0001`, t.tokens[1]);

    // Pre-register B's rename watcher.
    const renameMsg = nextMessage(
      wsB,
      (m) => m.type === "change" && (m as { change: Change }).change.operation === "rename",
    );

    // A creates old.md and target.md
    const acc1 = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-a-0001`, path: "old.md", operation: "create", baseRevision: 0 }) }));
    await acc1;
    const acc2 = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-a-0001`, path: "target.md", operation: "create", baseRevision: 1 }) }));
    await acc2;

    // A renames old.md -> moved.md
    const accRename = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-a-0001`, path: "moved.md", oldPath: "old.md", operation: "rename", baseRevision: 2 }) }));
    await accRename;

    const r = (await renameMsg) as Extract<ServerMessage, { type: "change" }>;
    expect(r.change.operation).toBe("rename");
    expect(r.change.oldPath).toBe("old.md");
    expect(r.change.path).toBe("moved.md");

    // B renames moved.md -> target.md based on stale rev 1: accepted (LWW);
    // the incoming commit becomes the latest revision of the log.
    const accStale = nextMessage(wsB, (m) => m.type === "accepted");
    wsB.send(JSON.stringify({ type: "change", change: change({ deviceId: `${t.accountId}-b-0001`, path: "target.md", oldPath: "moved.md", operation: "rename", baseRevision: 1 }) }));
    const stale = (await accStale) as Extract<ServerMessage, { type: "accepted" }>;
    expect(stale.revision).toBe(4);

    const log = await env.VAULT_DO.getByName(t.vaultId).changesAfter(0);
    const renames = log.filter((c) => c.operation === "rename");
    expect(renames).toHaveLength(2);
    expect(renames[0]).toMatchObject({ oldPath: "old.md", path: "moved.md" });
    expect(renames[1]).toMatchObject({ oldPath: "moved.md", path: "target.md" });
  });

  it("operation receipts survive GC for at-least-once retry safety", async () => {
    const t = await setup("mut3");
    const vaultId = t.vaultId;
    const stub = env.VAULT_DO.getByName(vaultId);
    const deviceId = `${t.accountId}-a-0001`;

    const c1 = change({ operationId: "gc-op-1", deviceId, path: "a.md", operation: "create", baseRevision: 0 });
    const first = await stub.submitChange(c1, deviceId);
    expect(first).toMatchObject({ status: "accepted", revision: 1 });

    // register a device in the vault and ack past rev 1 so GC can drop the change
    await stub.registerDevice(deviceId, "x");
    await stub.ack(deviceId, 1);
    await stub.ack(`${t.accountId}-b-0001`, 1);
    await stub.runGarbageCollection();

    // change log pruned
    const after = await stub.changesAfter(0);
    expect(after).toHaveLength(0);
    const status = await stub.status();
    expect(status.minRetainedRevision).toBe(2);

    // retry of the same operation still resolves idempotently via receipt
    const retry = await stub.submitChange(c1, deviceId);
    expect(retry).toMatchObject({ status: "accepted", revision: 1 });
  });

  it("signals RESYNC_REQUIRED to clients behind retained history and closes", async () => {
    const t = await setup("resync1");
    const stub = env.VAULT_DO.getByName(t.vaultId);
    const deviceA = `${t.accountId}-a-0001`;
    const deviceB = `${t.accountId}-b-0001`;

    // commit a change, both devices ack it, GC prunes it: retained floor moves to 2
    await stub.submitChange(change({ deviceId: deviceA, path: "a.md", operation: "create" }), deviceA);
    await stub.ack(deviceA, 1);
    await stub.ack(deviceB, 1);
    await stub.runGarbageCollection();
    const status = await stub.status();
    expect(status.minRetainedRevision).toBe(2);

    // a client at lastRevision 0 is behind -> resyncRequired welcome then close 4001
    const ws = await openWs(t.accountId, t.vaultId, deviceB);
    const welcomeP = nextMessage(ws, (m) => m.type === "welcome");
    const closeP = new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code));
    });
    const hello: ClientMessage = { type: "hello", accountId: t.accountId, vaultId: t.vaultId, deviceId: deviceB, token: t.tokens[1], lastRevision: 0 };
    ws.send(JSON.stringify(hello));
    const welcome = (await welcomeP) as Extract<ServerMessage, { type: "welcome" }>;
    expect(welcome.resyncRequired).toBe(true);
    expect(await closeP).toBe(4001);

    // a client at the retained floor (revision 1 == current) is fine
    const ws2 = await openWs(t.accountId, t.vaultId, deviceA);
    const welcome2P = nextMessage(ws2, (m) => m.type === "welcome");
    const hello2: ClientMessage = { type: "hello", accountId: t.accountId, vaultId: t.vaultId, deviceId: deviceA, token: t.tokens[0], lastRevision: 1 };
    ws2.send(JSON.stringify(hello2));
    const welcome2 = (await welcome2P) as Extract<ServerMessage, { type: "welcome" }>;
    expect(welcome2.resyncRequired).toBe(false);
  });
});