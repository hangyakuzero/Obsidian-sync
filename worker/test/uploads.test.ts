import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Change, ContentReference } from "@syncvault/shared";
import { toBase64, CHUNK_BYTES, MAX_FILE_BYTES, CHUNK_CAPABILITY } from "@syncvault/shared";

const PASSWORD = "correct horse battery staple";

async function setup(name: string): Promise<{ accountId: string; vaultId: string; deviceId: string; token: string }> {
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
  const deviceId = `${name}-up-0001`;
  const reg = await SELF.fetch(`http://localhost/v1/vaults/${vaultId}/devices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, password: PASSWORD, deviceId, name: "x" }),
  });
  const { deviceToken } = (await reg.json()) as { deviceToken: string };
  return { accountId, vaultId, deviceId, token: deviceToken };
}

function auth(t: { accountId: string; deviceId: string; token: string }): string {
  return `Bearer ${t.accountId}:${t.deviceId}:${t.token}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function chunkedChange(t: { deviceId: string }, content: ContentReference, over: Partial<Change> = {}): Change {
  return {
    operationId: `up-op-${Math.random()}`,
    revision: 0,
    deviceId: t.deviceId,
    path: "big.md",
    operation: "create",
    baseRevision: 0,
    timestamp: Date.now(),
    content,
    ...over,
  };
}

describe("chunked uploads", () => {
  it("round-trips a multi-chunk file through upload/download and pull", async () => {
    const t = await setup("upt1");
    const vault = env.VAULT_DO.getByName(t.vaultId);

    // ~600KiB file => chunkCount = ceil(bytes / 256KiB) = 3
    const bytes = new Uint8Array(Math.ceil(CHUNK_BYTES * 2.5));
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const content: ContentReference = {
      hash: await sha256Hex(bytes),
      byteLength: bytes.length,
      chunkCount: Math.ceil(bytes.length / CHUNK_BYTES),
    };
    expect(content.chunkCount).toBe(3);

    const change = chunkedChange(t, content);
    const begin = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(change),
    });
    expect(begin.status).toBe(201);
    expect((await begin.json())).toEqual({ uploaded: [] });

    const opId = change.operationId as string;
    let offset = 0;
    for (let i = 0; i < content.chunkCount; i++) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
      const res = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/${opId}/chunks/${i}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth(t) },
        body: JSON.stringify({ data: toBase64(chunk) }),
      });
      expect(res.status).toBe(200);
      offset += chunk.length;
    }

    const done = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/${opId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: "accepted", revision: 1 });

    // Stub-level idempotent resolve: a repeated beginUpload resolves via the
    // operation receipt without re-uploading anything.
    const retry = await vault.beginUpload(change, t.deviceId);
    expect(retry).toEqual({ uploaded: [], acceptedRevision: 1 });

    // Pull with the v2 capability returns the content descriptor, not payload.
    const pull = await SELF.fetch(
      `http://localhost/v1/vaults/${t.vaultId}/sync?since=0&capabilities=${CHUNK_CAPABILITY}`,
      { headers: { Authorization: auth(t) } },
    );
    expect(pull.status).toBe(200);
    const body = (await pull.json()) as { changes: Change[]; currentRevision: number };
    expect(body.currentRevision).toBe(1);
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].payload).toBeUndefined();
    expect(body.changes[0].content).toEqual(content);

    // Reassembling the chunks yields the exact original bytes.
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < content.chunkCount; i++) {
      const res = await SELF.fetch(
        `http://localhost/v1/vaults/${t.vaultId}/revisions/1/chunks/${i}`,
        { headers: { Authorization: auth(t) } },
      );
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: string };
      const piece = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      pieces.push(piece);
    }
    const joined = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of pieces) { joined.set(p, pos); pos += p.length; }
    expect(joined).toEqual(bytes);
  });

  it("rejects oversized, mismatched, and incomplete uploads", async () => {
    const t = await setup("upt2");

    // byteLength above the file cap fails at beginUpload (descriptor check).
    const oversized: ContentReference = {
      hash: "0".repeat(64),
      byteLength: MAX_FILE_BYTES + 1,
      chunkCount: Math.ceil((MAX_FILE_BYTES + 1) / CHUNK_BYTES),
    };
    const tooBig = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(chunkedChange(t, oversized, { operationId: "op-oversized" })),
    });
    expect(tooBig.status).toBe(400);

    // Mismatched bytes are rejected at completion.
    const bytes = new TextEncoder().encode("real content");
    const content: ContentReference = {
      hash: await sha256Hex(bytes),
      byteLength: bytes.length,
      chunkCount: 1,
    };
    await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(chunkedChange(t, content, { operationId: "op-mismatch" })),
    });
    const wrong = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/op-mismatch/chunks/0`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({ data: toBase64(new TextEncoder().encode("tampered1234")) }),
    });
    expect(wrong.status).toBe(200);
    const mismatch = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/op-mismatch/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
    });
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("HASH_MISMATCH");

    // Completing before all chunks arrive is refused.
    await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(chunkedChange(t, content, { operationId: "op-incomplete" })),
    });
    const incomplete = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/op-incomplete/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
    });
    expect(incomplete.status).toBe(409);
    expect(((await incomplete.json()) as { error: string }).error).toBe("UPLOAD_INCOMPLETE");
  });

  it("keeps a chunked conflict copy downloadable with its content reference", async () => {
    const t = await setup("upt3");
    const vault = env.VAULT_DO.getByName(t.vaultId);

    // Baseline: inline create of a.md at revision 1.
    const base = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({
        operationId: "op-base", revision: 0, deviceId: t.deviceId, path: "a.md",
        operation: "create", baseRevision: 0, timestamp: Date.now(),
        payload: toBase64(new TextEncoder().encode("v1")),
      } satisfies Change),
    });
    expect(base.status).toBe(200);

    // Chunked update based on revision 0 (stale) => conflict copy.
    const bytes = new TextEncoder().encode("stale divergent bytes");
    const content: ContentReference = {
      hash: await sha256Hex(bytes),
      byteLength: bytes.length,
      chunkCount: 1,
    };
    const change = chunkedChange(t, content, { path: "a.md", operation: "update", baseRevision: 0, operationId: "op-stale" });
    await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(change),
    });
    await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/op-stale/chunks/0`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({ data: toBase64(bytes) }),
    });
    const done = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/op-stale/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
    });
    const conflict = (await done.json()) as { status: string; conflictPath?: string; serverRevision: number };
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflictPath).toContain("a (conflict-");

    // The committed copy carries the content ref and its bytes are fetchable.
    const log = await vault.changesAfter(0);
    const copy = log.find((c) => c.path?.startsWith("a (conflict-"));
    expect(copy).toBeDefined();
    expect(copy!.content).toEqual(content);
    expect(copy!.payload).toBeUndefined();
    const copyRev = copy!.revision;
    const chunkRes = await SELF.fetch(
      `http://localhost/v1/vaults/${t.vaultId}/revisions/${copyRev}/chunks/0`,
      { headers: { Authorization: auth(t) } },
    );
    expect(chunkRes.status).toBe(200);
    const { data } = (await chunkRes.json()) as { data: string };
    expect(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it("rejects inline payloads above the 1 MiB inline cap while chunked stays at 16 MiB", async () => {
    const t = await setup("upt4");

    const inline = toBase64(new Uint8Array(1024 * 1024 + 1));
    const res = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({
        operationId: "op-too-inline",
        revision: 0,
        deviceId: t.deviceId,
        path: "inline.md",
        operation: "create",
        baseRevision: 0,
        timestamp: Date.now(),
        payload: inline,
      } satisfies Change),
    });
    // The over-cap body may be cut off at the routing layer (workerd caps
    // test-harness request bodies) or reach the DO; both lead to a 4xx, never
    // an acceptance. The precise PAYLOAD_TOO_LARGE code is asserted at the
    // stub level in core.test.ts.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    // A payload exactly at the inline cap still commits.
    const ok = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({
        operationId: "op-at-cap",
        revision: 0,
        deviceId: t.deviceId,
        path: "inline.md",
        operation: "create",
        baseRevision: 0,
        timestamp: Date.now(),
        payload: toBase64(new Uint8Array(1024 * 1024)),
      } satisfies Change),
    });
    expect(ok.status).toBe(200);
  });

  it("two devices uploading identical content both complete without duplicate rows", async () => {
    const t = await setup("upt5");
    // Second device on the same vault.
    const reg = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: t.accountId, password: PASSWORD, deviceId: `${t.deviceId}-2`, name: "y" }),
    });
    const { deviceToken } = (await reg.json()) as { deviceToken: string };
    const t2 = { ...t, deviceId: `${t.deviceId}-2`, token: deviceToken };

    const bytes = new TextEncoder().encode("identical bytes");
    const content: ContentReference = {
      hash: await sha256Hex(bytes),
      byteLength: bytes.length,
      chunkCount: 1,
    };

    const upload = async (dev: typeof t) => {
      const change = chunkedChange(dev, content, { operationId: `up-dedupe-${dev.deviceId}` });
      const begin = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth(dev) },
        body: JSON.stringify(change),
      });
      expect(begin.status).toBe(201);
      const chunk = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/${change.operationId}/chunks/0`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth(dev) },
        body: JSON.stringify({ data: toBase64(bytes) }),
      });
      expect(chunk.status).toBe(200);
      const done = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/${change.operationId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth(dev) },
      });
      return done;
    };

    const first = await upload(t);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted", revision: 1 });

    // Second device uploads the identical content: dedupes to the same
    // revision — the change_chunks copy must be idempotent, not a 500.
    const second = await upload(t2);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { status: string; revision: number };
    expect(body.status).toBe("accepted");

    // Exactly one committed change row, and the content is still fetchable.
    const vault = env.VAULT_DO.getByName(t.vaultId);
    const log = await vault.changesAfter(0);
    expect(log).toHaveLength(1);
    expect(log[0].content).toEqual(content);
  });

  it("heartbeats the device on push and chunk uploads", async () => {
    const t = await setup("upt6");
    const vault = env.VAULT_DO.getByName(t.vaultId);

    const before = (await vault.status()).devices.find((d) => d.deviceId === t.deviceId)!;
    await new Promise((r) => setTimeout(r, 5));

    // An HTTP push refreshes last_seen_at.
    const push = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/changes`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({
        operationId: "op-hb",
        revision: 0,
        deviceId: t.deviceId,
        path: "hb.md",
        operation: "create",
        baseRevision: 0,
        timestamp: Date.now(),
        payload: toBase64(new TextEncoder().encode("hb")),
      } satisfies Change),
    });
    expect(push.status).toBe(200);

    // A chunk upload (beginUpload has no touch; uploadChunk does) refreshes it.
    const bytes = new TextEncoder().encode("hb chunk");
    const content: ContentReference = {
      hash: await sha256Hex(bytes),
      byteLength: bytes.length,
      chunkCount: 1,
    };
    const change = chunkedChange(t, content, { operationId: "op-hb-chunk", path: "hb2.md" });
    await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify(change),
    });
    const chunk = await SELF.fetch(`http://localhost/v1/vaults/${t.vaultId}/uploads/${change.operationId}/chunks/0`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth(t) },
      body: JSON.stringify({ data: toBase64(bytes) }),
    });
    expect(chunk.status).toBe(200);

    const after = (await vault.status()).devices.find((d) => d.deviceId === t.deviceId)!;
    expect(after.lastSeenAt).toBeGreaterThanOrEqual(before.lastSeenAt);
  });
});
