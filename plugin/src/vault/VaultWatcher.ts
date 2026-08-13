import { Change, CHUNK_BYTES, MAX_FILE_BYTES, normalizePath } from "@syncvault/shared";
import { sha256Hex } from "../hashing/hash";

export type NormalizedEvent =
  | { kind: "create" | "modify"; path: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; path: string; oldPath: string };

export interface CaptureContext {
  readBytes(path: string): Promise<ArrayBuffer | null>;
  getBaseRevision(): number;
  onChange(change: Change): Promise<void>;
  onTooLarge?(path: string, size: number): void;
  /**
   * Snapshot content bytes to durable staging before the change is queued.
   * The queue references the staged file; the upload is served from the
   * snapshot so a concurrently edited vault file cannot corrupt it.
   */
  stage?(operationId: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
}

const DEBOUNCE_MS = 800;
// Expected operations live long enough for the filesystem watcher to fire
// their follow-up events, and short enough that an immediately subsequent
// local edit is still captured.
const EXPECT_TTL_MS = 5_000;

type ExpectedKind = "content" | "delete" | "rename";

interface ExpectedOp {
  kind: ExpectedKind;
  sha?: string;
  oldPath?: string;
  until: number;
  matchesLeft: number;
}

/**
 * Capture + expected-op suppression. Remote writes are matched exactly
 * (`{path, op, sha}`) rather than blanket-suppressed for a time window: a
 * follow-up event is swallowed only when it matches what the engine is about
 * to do (or just did) to the filesystem. A mismatched event — or a hash that
 * differs from the written bytes — is a real local edit and queues normally.
 */
export class VaultWatcher {
  private pending = new Map<string, NormalizedEvent>();
  private expected = new Map<string, ExpectedOp>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ctx: CaptureContext,
    private ttlMs = EXPECT_TTL_MS,
  ) {}

  /**
   * Record the filesystem write the engine is about to perform so its echo
   * can be consumed without suppressing real local edits.
   */
  expect(
    path: string,
    kind: ExpectedKind,
    opts: { sha?: string; oldPath?: string } = {},
  ): void {
    let normalized: string;
    try {
      normalized = normalizePath(path);
    } catch {
      return;
    }
    if (!this.isSyncable(normalized)) return;
    this.expected.set(normalized, {
      kind,
      sha: opts.sha,
      oldPath: opts.oldPath,
      until: Date.now() + this.ttlMs,
      matchesLeft: kind === "content" ? 3 : 2,
    });
  }

  /** Clear all expectations (e.g. after a paused apply or on resume). */
  releaseAll(): void {
    this.expected.clear();
  }

  track(ev: NormalizedEvent): void {
    let path: string;
    try {
      path = normalizePath(ev.path);
      if (ev.kind === "rename") normalizePath(ev.oldPath ?? "");
    } catch {
      return;
    }
    if (!this.isSyncable(path)) return;
    if (this.consumeIfExpected(ev, path)) return;

    const key = this.keyOf(ev);
    if (ev.kind === "delete") {
      const hadCreate = this.pending.has(`create:${path}`);
      const hadRename = this.pending.has(`rename:${path}`);
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      if (!hadRename) this.pending.delete(`rename:${path}`);
      if (hadCreate && !hadRename) {
        this.scheduleFlush();
        return;
      }
    } else if (ev.kind === "rename") {
      const { oldPath } = ev;
      const pendingCreate = this.pending.get(`create:${oldPath}`);
      const pendingRename = this.pending.get(`rename:${oldPath}`);
      if (pendingCreate) {
        // A newly-created file renamed before the debounce flush is still one
        // create, just at its final path. There is no old server path to move.
        this.pending.delete(`create:${oldPath}`);
        this.pending.delete(`modify:${oldPath}`);
        this.pending.delete(`delete:${oldPath}`);
        this.pending.delete(`rename:${oldPath}`);
        this.pending.delete(`create:${path}`);
        this.pending.delete(`modify:${path}`);
        this.pending.delete(`delete:${path}`);
        this.pending.set(`create:${path}`, { kind: "create", path });
        this.scheduleFlush();
        return;
      }
      if (pendingRename?.kind === "rename") {
        // Collapse a rename chain while retaining its original source.
        this.pending.delete(`rename:${oldPath}`);
        this.pending.delete(`rename:${path}`);
        this.pending.set(`rename:${path}`, {
          kind: "rename",
          path,
          oldPath: pendingRename.oldPath,
        });
        this.scheduleFlush();
        return;
      }
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      this.pending.delete(`delete:${path}`);
      // Do not remove pending events for oldPath: a modify followed by a
      // rename is an ordered modify-then-rename sequence.
    } else {
      this.pending.delete(`delete:${path}`);
      if (ev.kind === "create") this.pending.delete(`rename:${path}`);
      this.pending.delete(ev.kind === "create" ? `modify:${path}` : `create:${path}`);
    }
    this.pending.set(key, ev);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const ev of events) {
      await this.emitOne(ev);
    }
  }

  private consumeIfExpected(ev: NormalizedEvent, path: string): boolean {
    const exp = this.expected.get(path);
    if (!exp) return false;
    if (exp.until < Date.now()) {
      this.expected.delete(path);
      return false;
    }
    if (ev.kind === "delete") {
      if (exp.kind === "delete") {
        this.consume(path, exp);
        return true;
      }
      // A delete during an expected content/rename op is a real local edit.
      this.expected.delete(path);
      return false;
    }
    if (ev.kind === "rename") {
      if (exp.kind === "rename" && exp.oldPath === ev.oldPath) {
        this.consume(path, exp);
        return true;
      }
      this.expected.delete(path);
      return false;
    }
    // create/modify on an expected rename: post-rename metadata touch.
    if (exp.kind === "rename") {
      this.consume(path, exp);
      return true;
    }
    // create/modify on an expected content write: matched by hash at flush
    // time in emitOne, so it enters the pending set for now.
    return false;
  }

  private consume(path: string, exp: ExpectedOp): void {
    exp.matchesLeft -= 1;
    if (exp.matchesLeft <= 0) this.expected.delete(path);
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }

  private async emitOne(ev: NormalizedEvent): Promise<void> {
    if (ev.kind === "delete") {
      const change: Change = {
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: normalizePath(ev.path),
        operation: "delete",
        baseRevision: this.ctx.getBaseRevision(),
        timestamp: Date.now(),
      };
      await this.ctx.onChange(change);
      return;
    }
    if (ev.kind === "rename") {
      const change: Change = {
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: normalizePath(ev.path),
        oldPath: normalizePath(ev.oldPath ?? ""),
        operation: "rename",
        baseRevision: this.ctx.getBaseRevision(),
        timestamp: Date.now(),
      };
      await this.ctx.onChange(change);
      return;
    }
    const bytes = await this.ctx.readBytes(ev.path);
    if (bytes === null) return;
    if (bytes.byteLength > MAX_FILE_BYTES) {
      this.ctx.onTooLarge?.(ev.path, bytes.byteLength);
      return;
    }
    if (bytes.byteLength === 0) {
      // Obsidian never saves empty files; skip rather than hash nothing.
      return;
    }
    const data = new Uint8Array(bytes);
    const exp = this.expected.get(ev.path);
    if (exp && exp.until > Date.now() && exp.kind === "content") {
      const hash = await sha256Hex(data);
      if (exp.sha === undefined || hash === exp.sha) {
        this.consume(ev.path, exp);
        return;
      }
      // The bytes differ from what the engine wrote: a real local edit.
      this.expected.delete(ev.path);
    }
    const operationId = this.newOperationId();
    if (this.ctx.stage) await this.ctx.stage(operationId, data);
    const change: Change = {
      operationId,
      revision: 0,
      deviceId: "",
      path: normalizePath(ev.path),
      operation: ev.kind === "modify" ? "update" : "create",
      baseRevision: this.ctx.getBaseRevision(),
      timestamp: Date.now(),
      content: {
        hash: await sha256Hex(data),
        byteLength: data.byteLength,
        chunkCount: Math.max(1, Math.ceil(data.byteLength / CHUNK_BYTES)),
      },
    };
    await this.ctx.onChange(change);
  }

  private keyOf(ev: NormalizedEvent): string {
    return ev.kind === "rename" ? `rename:${ev.path}` : `${ev.kind}:${ev.path}`;
  }

  private isSyncable(path: string): boolean {
    if (path === ".obsidian" || path.startsWith(".obsidian/")) return false;
    return true;
  }

  private newOperationId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
