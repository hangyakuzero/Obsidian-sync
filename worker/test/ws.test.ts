import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Change, ClientMessage, ServerMessage } from "@syncvault/shared";
import { toBase64 } from "@syncvault/shared";

const PASSWORD = "correct horse battery staple";

interface TestSetup {
  accountId: string;
  vaultId: string;
  deviceA: string;
  deviceB: string;
  tokenA: string;
  tokenB: string;
}

async function setup(name: string): Promise<TestSetup> {
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
  const deviceA = `${name}-a-0001`;
  const deviceB = `${name}-b-0001`;
  const regA = await SELF.fetch(`http://localhost/v1/vaults/${vaultId}/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, deviceId: deviceA, name: "desktop" }),
  });
  const regB = await SELF.fetch(`http://localhost/v1/vaults/${vaultId}/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, deviceId: deviceB, name: "mobile" }),
  });
  const tokenA = ((await regA.json()) as { deviceToken: string }).deviceToken;
  const tokenB = ((await regB.json()) as { deviceToken: string }).deviceToken;
  return { accountId, vaultId, deviceA, deviceB, tokenA, tokenB };
}

async function openWs(
  accountId: string,
  vaultId: string,
  deviceId: string,
  lastRevision: number,
): Promise<WebSocket> {
  const res = await SELF.fetch(
    `http://localhost/v1/vaults/${vaultId}/ws?accountId=${accountId}&deviceId=${deviceId}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

function hello(
  accountId: string,
  vaultId: string,
  deviceId: string,
  token: string,
  lastRevision: number,
): string {
  const msg: ClientMessage = { type: "hello", accountId, vaultId, deviceId, token, lastRevision };
  return JSON.stringify(msg);
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

const opSeq = {
  _n: 0,
  next(): string {
    this._n += 1;
    return `test-op-${this._n}`;
  },
};

function changeMsg(deviceId: string, over: Partial<Change>): string {
  const change: Change = {
    operationId: opSeq.next(),
    revision: 0,
    deviceId,
    path: "hello.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    payload: toBase64(new TextEncoder().encode("# Hello")),
    ...over,
  };
  const msg: ClientMessage = { type: "change", change };
  return JSON.stringify(msg);
}

describe("websocket sync", () => {
  it("connects two devices, one-way create propagates, ACK advances revision", async () => {
    const t = await setup("wstest1");
    const wsA = await openWs(t.accountId, t.vaultId, t.deviceA, 0);
    const welcomeAP = nextMessage(wsA, (m) => m.type === "welcome");
    wsA.send(hello(t.accountId, t.vaultId, t.deviceA, t.tokenA, 0));
    const welcomeA = await welcomeAP;
    expect(welcomeA).toMatchObject({ serverRevision: 0, resyncRequired: false });

    const wsB = await openWs(t.accountId, t.vaultId, t.deviceB, 0);
    const welcomeBP = nextMessage(wsB, (m) => m.type === "welcome");
    wsB.send(hello(t.accountId, t.vaultId, t.deviceB, t.tokenB, 0));
    await welcomeBP;

    // Device A creates hello.md
    wsA.send(changeMsg(t.deviceA, { path: "hello.md", operation: "create", payload: toBase64(new TextEncoder().encode("# Hello")) }));
    const acceptedP = nextMessage(wsA, (m) => m.type === "accepted");
    const changeOnB = nextMessage(wsB, (m) => m.type === "change");
    const accepted = (await acceptedP) as Extract<
      ServerMessage,
      { type: "accepted" }
    >;
    expect(accepted.revision).toBe(1);

    // Device B receives the change and ACKs
    const received = await changeOnB;
    expect(received).toMatchObject({
      type: "change",
      change: { operation: "create", path: "hello.md", revision: 1 },
    });
    const revB = (received as { type: "change"; change: Change }).change.revision;
    wsB.send(JSON.stringify({ type: "ack", revision: revB } satisfies ClientMessage));

    const status = await env.VAULT_DO.getByName(t.vaultId).status();
    expect(status.currentRevision).toBe(1);
  });

  it("rejects a bad token and catches a stale write as a conflict copy", async () => {
    const t = await setup("wstest2");
    // bad token -> closed with 4401
    const wsBad = await openWs(t.accountId, t.vaultId, t.deviceA, 0);
    const closed = new Promise<number>((resolve) => {
      wsBad.addEventListener("close", (ev) => resolve(ev.code));
    });
    wsBad.send(hello(t.accountId, t.vaultId, t.deviceA, "deadbeef", 0));
    expect(await closed).toBe(4401);

    // two honest devices
    const wsA = await openWs(t.accountId, t.vaultId, t.deviceA, 0);
    const welcomeAP = nextMessage(wsA, (m) => m.type === "welcome");
    wsA.send(hello(t.accountId, t.vaultId, t.deviceA, t.tokenA, 0));
    await welcomeAP;
    const wsB = await openWs(t.accountId, t.vaultId, t.deviceB, 0);
    const welcomeBP = nextMessage(wsB, (m) => m.type === "welcome");
    wsB.send(hello(t.accountId, t.vaultId, t.deviceB, t.tokenB, 0));
    await welcomeBP;

    // A creates
    const acceptedA = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(changeMsg(t.deviceA, { path: "A.md", operation: "create", payload: toBase64(new TextEncoder().encode("v1")) }));
    await acceptedA;

    // B edits A.md based on revision 0 (stale) -> conflict + conflict copy broadcast
    const conflictP = nextMessage(wsB, (m) => m.type === "conflict");
    const copyP = nextMessage(wsB, (m) => m.type === "change");
    wsB.send(changeMsg(t.deviceB, { path: "A.md", operation: "update", baseRevision: 0, payload: toBase64(new TextEncoder().encode("v2B")) }));
    const conflict = (await conflictP) as Extract<ServerMessage, { type: "conflict" }>;
    expect(conflict.path).toBe("A.md");
    expect(conflict.conflictPath).toContain("A (conflict-");

    // Device B also receives its own conflict copy as a change (broadcast to all)
    const copy = (await copyP) as { type: "change"; change: Change };
    expect(copy.change.path).toContain("conflict");
    expect(copy.change.operation).toBe("create");
    expect(copy.change.payload).toBe(toBase64(new TextEncoder().encode("v2B")));

    // Server state: A.md canonical (rev 1), conflict copy (rev 2)
    const log = await env.VAULT_DO.getByName(t.vaultId).changesAfter(0);
    expect(log.map((c) => `${c.revision}:${c.path}`)).toEqual(["1:A.md", `2:${conflict.conflictPath}`]);
  });

  it("catch-up replays changes after the client's last revision", async () => {
    const t = await setup("wstest3");
    const wsA = await openWs(t.accountId, t.vaultId, t.deviceA, 0);
    wsA.send(hello(t.accountId, t.vaultId, t.deviceA, t.tokenA, 0));
    await nextMessage(wsA, (m) => m.type === "welcome");

    const accX = nextMessage(wsA, (m) => m.type === "accepted");
    const accY = nextMessage(wsA, (m) => m.type === "accepted");
    wsA.send(changeMsg(t.deviceA, { path: "x.md", operation: "create" }));
    wsA.send(changeMsg(t.deviceA, { path: "y.md", operation: "create" }));
    await accX;
    await accY;

    // New client connects at lastRevision 0 -> replays both changes via batch
    const wsC = await openWs(t.accountId, t.vaultId, t.deviceB, 0);
    const welcomeCP = nextMessage(wsC, (m) => m.type === "welcome");
    const batchP = nextMessage(wsC, (m) => m.type === "batch");
    wsC.send(hello(t.accountId, t.vaultId, t.deviceB, t.tokenB, 0));
    await welcomeCP;
    const batch = (await batchP) as { type: "batch"; items: ServerMessage[] };
    const paths = batch.items
      .filter((i) => i.type === "change")
      .map((i) => (i as { type: "change"; change: Change }).change.path)
      .sort();
    expect(paths).toEqual(["x.md", "y.md"]);
  });
});
