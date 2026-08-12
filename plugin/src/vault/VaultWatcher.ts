import { Change, MAX_FILE_BYTES, normalizePath, toBase64 } from "@syncvault/shared";

export type NormalizedEvent =
  | { kind: "create" | "modify"; path: string }
  | { kind: "delete"; path: string }
  | { kind: "rename"; path: string; oldPath: string };

export interface CaptureContext {
  readBytes(path: string): Promise<ArrayBuffer | null>;
  getBaseRevision(): number;
  onChange(change: Change): Promise<void>;
  onTooLarge?(path: string, size: number): void;
}

const DEBOUNCE_MS = 800;
const SUPPRESS_TTL_MS = 60_000;

export class VaultWatcher {
  private pending = new Map<string, NormalizedEvent>();
  private suppressed = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: CaptureContext) {}

  track(ev: NormalizedEvent): void {
    let path: string;
    try {
      path = normalizePath(ev.path);
      if (ev.kind === "rename") normalizePath(ev.oldPath ?? "");
    } catch {
      return;
    }
    if (!this.isSyncable(path)) return;
    if (this.isSuppressed(path)) return;
    if (ev.kind === "rename" && this.isSuppressed(ev.oldPath!)) return;

    const key = this.keyOf(ev);
    if (ev.kind === "delete") {
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      this.pending.delete(`rename:${path}`);
    } else if (ev.kind === "rename") {
      const { oldPath } = ev;
      this.pending.delete(`create:${oldPath}`);
      this.pending.delete(`modify:${oldPath}`);
      this.pending.delete(`delete:${oldPath}`);
      this.pending.delete(`rename:${oldPath}`);
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      this.pending.delete(`delete:${path}`);
    } else {
      this.pending.delete(`delete:${path}`);
      this.pending.delete(`rename:${path}`);
      this.pending.delete(ev.kind === "create" ? `modify:${path}` : `create:${path}`);
    }
    this.pending.set(key, ev);
    this.scheduleFlush();
  }

  /** Suppress vault events for paths being modified by remote-change application. */
  suppress(paths: string[]): void {
    const until = Date.now() + SUPPRESS_TTL_MS;
    for (const p of paths) {
      try {
        this.suppressed.set(normalizePath(p), until);
      } catch {
        // ignore invalid paths
      }
    }
  }

  releaseAll(): void {
    this.suppressed.clear();
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
    const change: Change = {
      operationId: this.newOperationId(),
      revision: 0,
      deviceId: "",
      path: normalizePath(ev.path),
      operation: ev.kind === "modify" ? "update" : "create",
      baseRevision: this.ctx.getBaseRevision(),
      timestamp: Date.now(),
      payload: toBase64(new Uint8Array(bytes)),
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

  private isSuppressed(path: string): boolean {
    const until = this.suppressed.get(path);
    if (until === undefined) return false;
    if (until < Date.now()) {
      this.suppressed.delete(path);
      return false;
    }
    return true;
  }

  private newOperationId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}