import { describe, expect, it, vi } from "vitest";
import { VaultWatcher, CaptureContext } from "../src/vault/VaultWatcher";
import { Change, MAX_FILE_BYTES, fromBase64 } from "@syncvault/shared";

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
  it("captures a create with base64 payload on flush (debounced)", async () => {
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
    expect(Array.from(fromBase64(c.payload!))).toEqual([...new TextEncoder().encode("# Hello")]);
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
    expect(changes[0].payload).toBeDefined();
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
    expect(changes[0].payload).toBeDefined();
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

  it("suppresses events for paths being applied remotely", async () => {
    const { ctx, changes } = makeContext();
    const watcher = new VaultWatcher(ctx);
    watcher.suppress(["Hello.md"]);
    watcher.track({ kind: "modify", path: "Hello.md" });
    await watcher.flush();
    expect(changes.length).toBe(0);
  });

  it("releaseAll() re-enables capture", async () => {
    const { ctx, changes, reads } = makeContext();
    const watcher = new VaultWatcher(ctx);
    reads.set("Hello.md", encode("hi"));
    watcher.suppress(["Hello.md"]);
    watcher.releaseAll();
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
