import { describe, expect, it, vi } from "vitest";
import { VaultWatcher, CaptureContext } from "../src/vault/VaultWatcher";
import { Change, MAX_FILE_BYTES } from "@syncvault/shared";
import { sha256Hex } from "../src/hashing/hash";

function makeContext(over: Partial<CaptureContext> = {}): {
  ctx: CaptureContext;
  changes: Change[];
  reads: Map<string, ArrayBuffer>;
  tooLarge: { path: string; size: number }[];
} {
  const changes: Change[] = [];
  const reads = new Map<string, ArrayBuffer>();
  const tooLarge: { path: string; size: number }[] = [];
  const ctx: CaptureContext = {
    readBytes: async (path) => reads.get(path) ?? null,
    getBaseRevision: () => 5,
    onChange: async (c) => changes.push(c),
    onTooLarge: (path, size) => tooLarge.push({ path, size }),
    ...over,
  };
  return { ctx, changes, reads, tooLarge };
}

function encode(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

describe("VaultWatcher", () => {
  it("captures a create with a content descriptor on flush (debounced)", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("Hello.md", encode("# Hello"));
    watcher.track({ kind: "create", path: "Hello.md" });
    await watcher.flush();
    expect(changes.length).toBe(1);
    const c = changes[0];
    expect(c.operation).toBe("create");
    expect(c.path).toBe("Hello.md");
    expect(c.baseRevision).toBe(5);
    const bytes = new TextEncoder().encode("# Hello");
    expect(c.content).toEqual({
      hash: await sha256Hex(bytes),
      byteLength: bytes.byteLength,
      chunkCount: 1,
    });
  });

  it("coalesces rapid modifies into one change reading final content", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("a.md", encode("v3"));
    watcher.track({ kind: "modify", path: "a.md" });
    watcher.track({ kind: "modify", path: "a.md" });
    watcher.track({ kind: "modify", path: "a.md" });
    await watcher.flush();
    expect(changes.length).toBe(1);
    expect(changes[0].content).toBeDefined();
  });

  it("delete wins over earlier write; rename drops both sides", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.track({ kind: "modify", path: "a.md" });
    watcher.track({ kind: "delete", path: "a.md" });
    watcher.track({ kind: "create", path: "old.md" });
    watcher.track({ kind: "rename", path: "new.md", oldPath: "old.md" });
    await watcher.flush();
    expect(changes.map((c) => c.operation)).toEqual(["delete"]);
  });

  it("collapses create-then-rename into a content-bearing create at the final path", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("new.md", encode("created"));
    watcher.track({ kind: "create", path: "old.md" });
    watcher.track({ kind: "rename", path: "new.md", oldPath: "old.md" });
    await watcher.flush();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ operation: "create", path: "new.md" });
    expect(changes[0].content).toBeDefined();
  });

  it("keeps rename followed by modify as two ordered events", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("new.md", encode("updated"));
    watcher.track({ kind: "rename", path: "new.md", oldPath: "old.md" });
    watcher.track({ kind: "modify", path: "new.md" });
    await watcher.flush();
    expect(changes.map((c) => c.operation)).toEqual(["rename", "update"]);
  });

  it("keeps rename followed by delete as two ordered events", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.track({ kind: "rename", path: "new.md", oldPath: "old.md" });
    watcher.track({ kind: "delete", path: "new.md" });
    await watcher.flush();
    expect(changes.map((c) => c.operation)).toEqual(["rename", "delete"]);
  });

  it("consumes an expected content write whose hash matches", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("Hello.md", encode("# Hello"));
    const sha = await sha256Hex(new TextEncoder().encode("# Hello"));
    watcher.expect("Hello.md", "content", { sha });
    watcher.track({ kind: "modify", path: "Hello.md" });
    await watcher.flush();
    expect(changes.length).toBe(0);
  });

  it("queues a real local edit when the hash differs from the expected write", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("Hello.md", encode("# edited locally"));
    watcher.expect("Hello.md", "content", { sha: await sha256Hex(new TextEncoder().encode("# Hello")) });
    watcher.track({ kind: "modify", path: "Hello.md" });
    await watcher.flush();
    expect(changes.length).toBe(1);
    expect(changes[0].operation).toBe("update");
  });

  it("consumes expected deletes and renames, but not mismatched ones", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.expect("bye.md", "delete");
    watcher.track({ kind: "delete", path: "bye.md" });
    watcher.expect("new.md", "rename", { oldPath: "old.md" });
    watcher.track({ kind: "rename", path: "new.md", oldPath: "old.md" });
    // a rename whose old path differs from the expectation is a real local edit
    watcher.expect("mismatch.md", "rename", { oldPath: "src.md" });
    watcher.track({ kind: "rename", path: "mismatch.md", oldPath: "other.md" });
    watcher.track({ kind: "modify", path: "mismatch.md" });
    watcher.track({ kind: "delete", path: "mismatch.md" });
    await watcher.flush();
    expect(changes.map((c) => c.operation)).toEqual(["rename", "delete"]);
  });

  it("treats a delete during an expected content write as a real local edit", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.expect("a.md", "content", { sha: "deadbeef" });
    watcher.track({ kind: "delete", path: "a.md" });
    await watcher.flush();
    expect(changes.map((c) => c.operation)).toEqual(["delete"]);
  });

  it("consumes a post-rename metadata touch against the rename expectation", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.expect("new.md", "rename", { oldPath: "old.md" });
    watcher.track({ kind: "rename", path: "new.md", oldPath: "old.md" });
    watcher.track({ kind: "modify", path: "new.md" });
    await watcher.flush();
    expect(changes.length).toBe(0);
  });

  it("releaseAll() clears expectations so the next event captures", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("Hello.md", encode("hi"));
    watcher.expect("Hello.md", "content", { sha: await sha256Hex(new TextEncoder().encode("remote")) });
    watcher.releaseAll();
    watcher.track({ kind: "modify", path: "Hello.md" });
    await watcher.flush();
    expect(changes.length).toBe(1);
  });

  it("expired expectations no longer suppress events", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx, 10);
    reads.set("Hello.md", encode("hi"));
    watcher.expect("Hello.md", "content", { sha: await sha256Hex(new TextEncoder().encode("remote")) });
    await new Promise((r) => setTimeout(r, 25));
    watcher.track({ kind: "modify", path: "Hello.md" });
    await watcher.flush();
    expect(changes.length).toBe(1);
  });

  it("skips .obsidian paths and rejects invalid paths", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.track({ kind: "modify", path: ".obsidian/workspace" });
    watcher.track({ kind: "modify", path: ".obsidian" });
    watcher.track({ kind: "create", path: "../escape.md" });
    await watcher.flush();
    expect(changes.length).toBe(0);
  });

  it("skips files over the size limit and reports them", async () => {
    const { ctx, changes, reads, tooLarge } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("big.bin", new ArrayBuffer(MAX_FILE_BYTES + 1));
    watcher.track({ kind: "create", path: "big.bin" });
    await watcher.flush();
    expect(changes.length).toBe(0);
    expect(tooLarge).toEqual([{ path: "big.bin", size: MAX_FILE_BYTES + 1 }]);
  });

  it("skips a write when the file vanished before flush", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.track({ kind: "modify", path: "ghost.md" });
    await watcher.flush();
    expect(changes.length).toBe(0);
  });
});
