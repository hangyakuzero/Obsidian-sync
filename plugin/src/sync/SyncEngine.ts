import { Change, CHUNK_BYTES, fromBase64, isValidBase64, isValidContentReference, MAX_FILE_BYTES, normalizePath, toBase64 } from "@syncvault/shared";
import { sha256Hex } from "../hashing/hash";
import { SyncState, QueuedChange } from "../state/SyncState";
import { Staging } from "../storage/Staging";
import { Journal } from "../storage/Journal";
import { ChangeQueue } from "./ChangeQueue";
import { VaultWatcher } from "../vault/VaultWatcher";
import { SyncConnection, ConnectionStatus, ConnectionCallbacks, Connection } from "./SyncConnection";
import { HttpConnection } from "./HttpConnection";
import { SyncClient } from "../api/SyncClient";

export type SyncStatus = "idle" | "syncing" | "downloading" | "uploading" | "conflict" | "offline" | "synced" | "paused";

export interface VaultOps {
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  stat(path: string): Promise<"file" | "folder" | null>;
}

export interface SeedScanner {
  listFiles(): Promise<{ path: string; size: number }[]>;
  readBytes?(path: string): Promise<ArrayBuffer | null>;
}

export interface EngineOptions {
  connectionFactory?: (handlers: ConnectionCallbacks) => Connection;
  client?: SyncClient;
  scanner?: SeedScanner;
  pollIntervalMs?: number;
  /** Durable byte snapshots; when set, uploads are served from here. */
  staging?: Staging;
}

type AckResult =
  | { status: "accepted"; revision: number }
  | { status: "conflict"; conflictPath?: string }
  | { status: "retry" }
  | { status: "rejected" };

interface PendingAck {
  resolve: (result: AckResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ACK_TIMEOUT_MS = 30_000;
const CHUNKED_ACK_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 4000;
const CONVERGE_ROUND_CAP = 10;
/**
 * Files at or below this size travel inside the change itself as a base64
 * payload (server stores them inline); larger files upload via content chunks.
 */
const MAX_INLINE_BYTES = 1024 * 1024;

export class SyncEngine {
  private connection: Connection;
  private statusValue: SyncStatus = "idle";
  private syncInFlight = false;
  private pendingAcks = new Map<string, PendingAck>();
  private ackTarget = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private pollIntervalMs: number;
  private scanner?: SeedScanner;
  private paused = false;
  private consecutiveAuthFailures = 0;
  private joinBackup = false;
  private resyncBlocked = false;
  private staging?: Staging;
  private journal: Journal;

  constructor(
    private state: SyncState,
    private queue: ChangeQueue,
    private watcher: VaultWatcher,
    private vault: VaultOps,
    private onStatus: (status: SyncStatus) => void,
    private onNotice: (message: string, timeout?: number) => void,
    options: EngineOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.scanner = options.scanner;
    this.staging = options.staging;
    this.journal = new Journal(state);
    const handlers: ConnectionCallbacks = {
      onWelcome: (serverRevision, resyncRequired) => this.handleWelcome(serverRevision, resyncRequired),
      onRemoteChange: (change) => this.applyRemoteChange(change),
      onAccepted: (operationId, revision) =>
        this.settleAck(operationId, { status: "accepted", revision }),
      onConflict: (c) =>
        this.settleAck(c.operationId, { status: "conflict", conflictPath: c.conflictPath }),
      onRejected: (operationId, code, message) => this.handleRejected(operationId, code, message),
      onAuthFailure: (message) => this.handleAuthFailure(message),
      onRetry: (operationId, message) => this.handleRetry(operationId, message),
      onResyncRequired: (message) => this.handleResyncRequired(message),
      onError: (message) => this.onNotice(`SyncVault: ${message}`, 6000),
      onStatusChange: (status) => this.handleConnectionStatus(status),
    };
    this.connection =
      options.connectionFactory?.(handlers) ??
      (options.client
        ? new HttpConnection(state, options.client, handlers)
        : new SyncConnection(
            () => ({
              serverUrl: this.state.serverUrl,
              accountId: this.state.accountId ?? "",
              vaultId: this.state.vaultId ?? "",
              deviceId: this.state.deviceId ?? "",
              token: this.state.deviceToken ?? "",
              getLastRevision: () => this.state.lastRevision,
            }),
            handlers,
          ));
  }

  get status(): SyncStatus {
    return this.statusValue;
  }

  get pendingCount(): number {
    return this.queue.size();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async start(): Promise<void> {
    if (!this.state.connected) return;
    this.connection.connect();
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    }
    await this.pollOnce();
    await this.reconcileStaging();
    await this.migrateLegacyPayloads();
  }

  stop(): void {
    this.connection.disconnect();
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.clearPendingAcks();
    this.syncInFlight = false;
    this.polling = false;
    this.paused = false;
    this.joinBackup = false;
    this.setStatus("idle");
  }

  async resetForRebuild(): Promise<void> {
    this.stop();
    this.ackTarget = 0;
    this.resyncBlocked = false;
    await this.queue.clear();
  }

  /**
   * Resume after a pause (or simply trigger a sync round): clears the paused
   * flag, (re)connects and runs one poll immediately.
   */
  async resume(): Promise<void> {
    this.paused = false;
    this.resyncBlocked = false;
    if (this.statusValue === "paused" || this.statusValue === "conflict") {
      this.setStatus("syncing");
    }
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    }
    await this.syncNow();
  }

  async syncNow(): Promise<void> {
    if (!this.state.connected) {
      this.onNotice("SyncVault: not configured", 4000);
      return;
    }
    this.paused = false;
    this.connection.connect();
    await this.pollOnce();
  }

  private async pollOnce(): Promise<void> {
    if (this.paused) return;
    if (!this.state.connected) return;
    if (this.polling) return;
    if (!this.connection.connected) return;
    this.polling = true;
    try {
      const capped = await this.converge();
      if (!capped && !this.paused) this.joinBackup = false;
      if (this.paused) return;
      if (capped) {
        // Revisions may still be arriving; never show a false "Synced".
        this.setStatus("syncing");
        setTimeout(() => void this.pollOnce(), 0);
      } else if (this.state.pendingChanges.length === 0) {
        this.setStatus(this.connection.connected ? "synced" : "offline");
      }
    } catch {
      this.setStatus("offline");
    } finally {
      this.polling = false;
    }
  }

  /**
   * Convergence loop: pull → apply → flush queue → pull again until both the
   * remote stream and this device's uploads are consumed (10-round cap).
   * Self-pushed and interleaved revisions are applied in revision order; only
   * applied revisions advance the cursor.
   */
  private async converge(): Promise<boolean> {
    for (let round = 0; round < CONVERGE_ROUND_CAP; round++) {
      const result = await this.connection.pull(this.state.lastRevision);
      if (result.resyncRequired) {
        this.handleResyncRequired(
          "local history is older than the server retention window. Resync is not supported yet.",
        );
        return false;
      }
      if (result.changes.length > 0) this.setStatus("downloading");
      for (const change of result.changes) {
        await this.applyRemoteChange(change);
        if (this.paused) return false;
      }
      await this.maybeSeed();
      await this.flushQueue();
      if (this.paused) return false;
      if (
        result.changes.length === 0 &&
        (this.state.pendingChanges.length === 0 || this.resyncBlocked)
      ) {
        return false;
      }
    }
    // The 10-round cap was hit: more work remains.
    return this.state.pendingChanges.length > 0;
  }

  private handleConnectionStatus(status: ConnectionStatus): void {
    if (status === "offline") {
      this.setStatus("offline");
    } else if (status === "open" && this.statusValue === "offline") {
      this.setStatus("synced");
    }
  }

  private handleAuthFailure(message: string): void {
    // 401s from transient issues (token expiry mid-flight, proxy quirks) are
    // retryable: warn without stopping. Only after three consecutive failures
    // do we pause once and ask the user to reconnect the vault.
    this.consecutiveAuthFailures += 1;
    if (this.consecutiveAuthFailures < 3) {
      this.onNotice(
        `SyncVault: ${message} (${this.consecutiveAuthFailures}/3) — retrying.`,
        6000,
      );
      return;
    }
    this.connection.disconnect();
    this.clearPendingAcks();
    this.paused = true;
    this.setStatus("paused");
    this.onNotice(
      `SyncVault: sync paused — ${message}. Reconnect the vault: Settings → Reconnect vault.`,
      10000,
    );
  }

  /** Called after a successful reconnect: resume polling with a clean slate. */
  authRecovered(): Promise<void> {
    this.consecutiveAuthFailures = 0;
    return this.resume();
  }

  private handleResyncRequired(message?: string): void {
    // Local history fell behind the server retention window. The queue is
    // preserved; the user must recover from an authoritative device. Abort
    // any push in flight and stop pushing until the vault is rebuilt — the
    // server will reject further uploads.
    this.resyncBlocked = true;
    this.clearPendingAcks();
    this.onNotice(
      `SyncVault: ${message ?? "local history is older than the server retention window. Resync is not supported yet."}`,
      10000,
    );
    this.setStatus("conflict");
  }

  private async handleWelcome(serverRevision: number, resyncRequired: boolean): Promise<void> {
    if (resyncRequired) {
      this.handleResyncRequired();
      return;
    }
    this.consecutiveAuthFailures = 0;
    this.setStatus("synced");
    if (!this.paused) await this.flushQueue();
  }

  private async applyRemoteChange(change: Change): Promise<void> {
    if (this.statusValue === "idle") this.setStatus("downloading");
    const paths = change.oldPath ? [change.path, change.oldPath] : [change.path];
    try {
      // Local observations for these paths must reach the queue before the
      // remote write so they are never lost to overwriting.
      await this.watcher.flush();
      await this.apply(change);
      // Remember paths whose content we seeded from the server so the initial
      // scan never re-uploads them as local-only files.
      await this.state.markApplied(change.path, change.oldPath);
      await this.journal.record({
        operationId: change.operationId,
        revision: change.revision,
        paths,
      });
    } catch (e) {
      // Never ACK an unapplied change: the cursor stays put so the change is
      // not lost. Instead of retrying forever, pause polling and surface a
      // single notice — resume only after the underlying issue is fixed.
      this.paused = true;
      this.setStatus("paused");
      this.onNotice(
        `SyncVault: sync paused — could not apply "${change.path}": ${(e as Error).message}. Fix the issue, then resume sync (Settings → Resume).`,
        10000,
      );
      return;
    }
    // Advance the cursor and ACK so the server can garbage-collect consumed changes.
    if (change.revision > this.ackTarget) {
      this.ackTarget = change.revision;
      await this.state.setLastRevision(change.revision);
      this.connection.sendAck(change.revision);
    }
    if (this.queue.size() === 0) this.setStatus("synced");
  }

  /**
   * First-run seed: enqueue every local file as a "create" so a device's
   * existing vault reaches the server. Pulled paths (marked applied) are
   * skipped, preventing duplicates and false conflicts on joined devices.
   */
  private async maybeSeed(): Promise<void> {
    if (this.state.seeded) return;
    if (!this.scanner) {
      await this.state.markSeeded();
      return;
    }
    let files: { path: string; size: number }[];
    try {
      files = await this.scanner.listFiles();
    } catch {
      return; // retried on next poll
    }
    for (const f of files) {
      if (!this.syncablePath(f.path)) continue;
      if (this.state.hasApplied(f.path)) continue;
      if (f.size > MAX_FILE_BYTES) continue;
      let content: Change["content"];
      if (this.scanner.readBytes) {
        let bytes: ArrayBuffer | null;
        try {
          bytes = await this.scanner.readBytes(f.path);
        } catch {
          // scan is incomplete; retry on the next poll instead of marking seeded
          return;
        }
        if (bytes === null) continue;
        if (bytes.byteLength > MAX_FILE_BYTES) continue;
        if (bytes.byteLength === 0) {
          // Zero-byte files travel as empty payloads; content uploads of zero
          // bytes have no chunks to send.
          await this.queue.enqueue({
            operationId: this.newOperationId(),
            revision: 0,
            deviceId: "",
            path: f.path,
            operation: "create",
            baseRevision: this.state.lastRevision,
            timestamp: Date.now(),
            payload: "",
          });
          continue;
        }
        const data = new Uint8Array(bytes);
        content = await this.contentFor(data);
        if (this.staging) {
          const operationId = this.newOperationId();
          await this.staging.save(operationId, data);
          await this.queue.enqueue({
            operationId,
            revision: 0,
            deviceId: "",
            path: f.path,
            operation: "create",
            baseRevision: this.state.lastRevision,
            timestamp: Date.now(),
            content,
            stagedFile: operationId,
          } as QueuedChange);
          continue;
        }
      }
      await this.queue.enqueue({
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: f.path,
        operation: "create",
        baseRevision: this.state.lastRevision,
        timestamp: Date.now(),
        content,
      });
    }
    await this.state.markSeeded();
  }

  /**
   * Queue path for watcher-captured changes. Content changes reference their
   * staged byte snapshot so the flush cannot read a file that changed again.
   */
  async enqueueLocal(change: Change): Promise<void> {
    if (change.content && change.operationId) {
      await this.queue.enqueue({ ...change, stagedFile: change.operationId } as QueuedChange);
    } else {
      await this.queue.enqueue(change);
    }
  }

  /**
   * Delete staged snapshots that survived a crash between staging and
   * enqueueing (or belong to a discarded queue); queued items retain theirs.
   */
  private async reconcileStaging(): Promise<void> {
    if (!this.staging) return;
    const queued = new Set(this.queue.items.map((item) => item.stagedFile).filter((id): id is string => !!id));
    for (const operationId of await this.staging.list()) {
      if (!queued.has(operationId)) await this.staging.remove(operationId);
    }
  }

  private async contentFor(bytes: Uint8Array<ArrayBuffer>): Promise<{ hash: string; byteLength: number; chunkCount: number }> {
    const hash = await sha256Hex(bytes);
    return {
      hash,
      byteLength: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES)),
    };
  }

  private syncablePath(path: string): boolean {
    try {
      const normalized = normalizePath(path);
      if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) return false;
      return true;
    } catch {
      return false;
    }
  }

  private newOperationId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async apply(change: Change): Promise<void> {
    // Redelivered changes (lost ACK, HTTP pull, reconnect) were already
    // applied; never touch the filesystem twice.
    if (this.journal.proven(change.operationId)) return;
    switch (change.operation) {
      case "create":
      case "update": {
        let sha: string | undefined;
        let data: Uint8Array<ArrayBuffer>;
        if (change.content !== undefined) {
          if (!isValidContentReference(change.content)) throw new Error("invalid content descriptor");
          const bytes = await this.connection.fetchContent(change);
          if (bytes === null) throw new Error("content could not be downloaded or verified");
          sha = change.content.hash;
          data = bytes as Uint8Array<ArrayBuffer>;
        } else {
          if (typeof change.payload !== "string") throw new Error("missing payload");
          if (!isValidBase64(change.payload)) throw new Error("invalid payload");
          data = fromBase64(change.payload) as Uint8Array<ArrayBuffer>;
          sha = await sha256Hex(data);
        }
        await this.ensureNoBlockingFile(normalizePath(change.path), change);
        const path = normalizePath(change.path);
        if (this.joinBackup) await this.backupIfDivergent(path, change, data);
        this.watcher.expect(path, "content", { sha });
        await this.vault.write(path, data);
        return;
      }
      case "delete": {
        // Missing target is a completed deletion (idempotent); never fail.
        const path = normalizePath(change.path);
        const kind = await this.vault.stat(path);
        if (kind === null) return;
        this.watcher.expect(path, "delete");
        await this.vault.remove(path);
        return;
      }
      case "rename": {
        if (!change.oldPath) throw new Error("rename missing oldPath");
        await this.applyRename(normalizePath(change.oldPath), normalizePath(change.path), change);
        return;
      }
    }
  }

  /**
   * Idempotent rename application:
   * - journal-proven operations are already complete (lost-ACK redelivery).
   * - source missing + destination present: either we renamed it, or the user
   *   did — either way the goal state holds; journal it and move on.
   * - both missing: genuinely ambiguous; pausing (never ACKing) is safer than
   *   guessing.
   * - occupied destination: preserve it as a queued conflict copy first.
   * - case-only rename: two-step through a unique temp name in the same folder
   *   because case-insensitive filesystems treat old==new.
   */
  private async applyRename(oldPath: string, newPath: string, change: Change): Promise<void> {
    if (this.journal.proven(change.operationId)) return;
    const oldKind = await this.vault.stat(oldPath);
    const newKind = await this.vault.stat(newPath);
    const caseOnly = oldPath !== newPath && oldPath.toLowerCase() === newPath.toLowerCase();

    if (oldKind === null && newKind !== null) {
      // Goal state already holds; never fail redelivery.
      await this.journal.record({
        operationId: change.operationId,
        revision: change.revision,
        paths: [newPath, oldPath],
      });
      return;
    }
    if (oldKind === null && newKind === null) {
      throw new Error("rename target and source are both missing");
    }
    if (newKind === "folder") {
      throw new Error("rename target is a folder");
    }
    if (newKind === "file") {
      const conflictPath = await this.freshLocalConflictPath(newPath, change);
      const bytes = await this.vault.readFile(newPath);
      if (bytes === null) throw new Error("could not read the occupied rename target");
      this.watcher.expect(conflictPath, "rename", { oldPath: newPath });
      await this.vault.rename(newPath, conflictPath);
      await this.enqueueConflictCopy(conflictPath, bytes);
    }
    if (caseOnly) {
      // Case-insensitive filesystems see oldPath === newPath; go through a
      // unique temp name in the same folder.
      const temp = this.caseRenameTemp(oldPath);
      this.watcher.expect(temp, "rename", { oldPath });
      await this.vault.rename(oldPath, temp);
      this.watcher.expect(newPath, "rename", { oldPath: temp });
      await this.vault.rename(temp, newPath);
    } else {
      this.watcher.expect(newPath, "rename", { oldPath });
      await this.vault.rename(oldPath, newPath);
    }
  }

  /**
   * A remote write must never silently fail because a file sits where a
   * folder belongs: back the blocking file up as a queued conflict copy, then
   * let the write create the folders.
   */
  private async ensureNoBlockingFile(path: string, change: Change): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const kind = await this.vault.stat(current);
      if (kind === null) break; // deeper ancestors do not exist yet
      if (kind === "file") {
        const conflictPath = await this.freshLocalConflictPath(current, change);
        const bytes = await this.vault.readFile(current);
        if (bytes === null) throw new Error("could not read the blocking ancestor file");
        this.watcher.expect(conflictPath, "rename", { oldPath: current });
        await this.vault.rename(current, conflictPath);
        await this.enqueueConflictCopy(conflictPath, bytes);
        return;
      }
    }
  }

  private async enqueueConflictCopy(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {    const operationId = this.newOperationId();
    if (this.staging) await this.staging.save(operationId, bytes);
    await this.enqueueLocal({
      operationId,
      revision: 0,
      deviceId: "",
      path,
      operation: "create",
      baseRevision: this.state.lastRevision,
      timestamp: Date.now(),
      content: await this.contentFor(bytes),
    });
  }

  /** Queue a local file for upload (used by the visual-appearance mirror).
   * Small files travel as inline base64 payloads like captured changes;
   * larger ones are staged and sent via their content descriptor. */
  async enqueueVisualChange(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength <= MAX_INLINE_BYTES) {
      await this.enqueueLocal({
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path,
        operation: "create",
        baseRevision: this.state.lastRevision,
        timestamp: Date.now(),
        payload: bytes.byteLength === 0 ? "" : toBase64(bytes),
      });
      return;
    }
    await this.enqueueConflictCopy(path, bytes);
  }

  /** Enter "join" recovery mode: remote applies back up divergent local files
   * as conflict copies instead of silently overwriting them. Cleared once the
   * baseline pull converges. */
  enterJoinMode(): void {
    this.joinBackup = true;
  }

  /** During join, preserve any local file that differs from the incoming
   * remote baseline as a conflict copy before the target is overwritten. */
  private async backupIfDivergent(
    path: string,
    change: Change,
    incoming: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const kind = await this.vault.stat(path);
    if (kind !== "file") return;
    const local = await this.vault.readFile(path);
    if (local === null || this.bytesEqual(local, incoming)) return;
    const saved = local as Uint8Array<ArrayBuffer>;
    const conflictPath = await this.freshLocalConflictPath(path, change);
    await this.enqueueConflictCopy(conflictPath, saved);
    this.watcher.expect(conflictPath, "content", { sha: await sha256Hex(saved) });
    await this.vault.write(conflictPath, saved);
  }

  private bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** Number of local files the initial seed would upload (for recovery safety
   * checks). Returns -1 if the scanner is unavailable or the scan failed. */
  async countSyncableFiles(): Promise<number> {
    if (!this.scanner) return -1;
    try {
      const files = await this.scanner.listFiles();
      let count = 0;
      for (const f of files) {
        if (!this.syncablePath(f.path)) continue;
        if (f.size > MAX_FILE_BYTES || f.size <= 0) continue;
        count += 1;
      }
      return count;
    } catch {
      return -1;
    }
  }

  /** Deterministic sibling name mirroring the server's conflict convention. */
  private async freshLocalConflictPath(path: string, change: Change): Promise<string> {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const stamp = new Date(change.timestamp || Date.now())
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 12);
    for (let i = 0; i < 100; i++) {
      const suffix = i === 0 ? "" : `-${i}`;
      const candidate = `${dir}${stem} (conflict-local-${stamp})${suffix}${ext}`;
      if (candidate === path) continue;
      if ((await this.vault.stat(candidate)) === null) return candidate;
    }
    throw new Error("could not allocate a conflict path");
  }

  private caseRenameTemp(path: string): string {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${dir}.${stem}-syncvault-${this.newOperationId().slice(0, 8)}${ext}`;
  }

  /**
   * v0.1.3-era devices carried small files as base64 payloads inside the
   * queue (data.json). Move them to durable staging once: drop the payload,
   * keep a content descriptor + stagedFile reference.
   */
  private async migrateLegacyPayloads(): Promise<void> {
    if (!this.staging) return;
    let changed = false;
    for (const item of this.queue.items) {
      if (item.stagedFile || typeof item.payload !== "string" || item.payload.length === 0) {
        continue;
      }
      try {
        const bytes = fromBase64(item.payload) as Uint8Array<ArrayBuffer>;
        await this.staging.save(item.operationId, bytes);
        item.content = await this.contentFor(bytes);
        item.stagedFile = item.operationId;
        item.payload = undefined;
        changed = true;
      } catch {
        // Leave malformed payloads untouched; they fail on the server anyway.
      }
    }
    if (changed) await this.state.save({});
  }

  private async flushQueue(): Promise<void> {
    if (!this.connection.connected) return;
    if (this.resyncBlocked) return;
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.setStatus(this.queue.size() > 0 ? "uploading" : this.statusValue);
    try {
      for (const item of [...this.queue.items]) {
        if (!this.connection.connected) break;
        let bytes: Uint8Array<ArrayBuffer> | undefined;
        let inlinePayload: string | undefined;
        if (item.content) {
          if (item.stagedFile && this.staging) {
            // Serve the upload from the durable snapshot taken at capture
            // time; the queue entry already references the same bytes, so no
            // hash re-check is needed.
            bytes = (await this.staging.load(item.stagedFile)) ?? undefined;
          }
          if (!bytes) {
            // No snapshot (staging disabled, or lost): fall back to a live
            // read and keep the legacy hash-check/refresh behavior.
            const read = await this.vault.readFile(item.path);
            if (read === null) {
              // The file is gone; nothing to upload. The watcher has queued
              // (or will queue) the deletion.
              await this.queue.remove(item.operationId);
              if (item.stagedFile) await this.staging?.remove(item.stagedFile);
              continue;
            }
            bytes = read;
            const hash = await sha256Hex(bytes);
            if (hash !== item.content.hash) {
              const fresh = await this.contentFor(bytes);
              await this.queue.refreshContent(item.operationId, fresh);
              item.content = fresh;
            }
          }
          if (bytes.byteLength <= MAX_INLINE_BYTES) {
            // Small files travel inline as base64 payloads; the server stores
            // them without a content upload round-trip.
            inlinePayload = toBase64(bytes);
          }
        }
        const result = await this.sendAndWait(item, inlinePayload !== undefined ? undefined : bytes, inlinePayload);
        if (result === null) break;
        if (result.status === "retry") break;
        if (result.status === "rejected") {
          // permanently rejected (e.g. legacy payload-less seed) — already
          // removed from the queue by handleRejected; do not advance the cursor
          continue;
        }
        if (result.status === "accepted") {
          await this.queue.remove(item.operationId);
          if (item.stagedFile) await this.staging?.remove(item.stagedFile);
          if (this.connection.advanceCursorOnAccept) {
            // WS: the pusher never sees its own change; the accept is the only
            // chance to advance the cursor.
            await this.state.setLastRevision(result.revision);
          }
          // HTTP: the pusher receives its own change via the next pull, and
          // the cursor advances at apply time in applyRemoteChange.
        } else {
          // The server committed the conflicting version as a conflict copy and
          // broadcast it to this device; the copy is applied via applyRemoteChange.
          await this.queue.removeDropped(item.operationId);
          if (item.stagedFile) await this.staging?.remove(item.stagedFile);
          this.setStatus("conflict");
        }
      }
    } finally {
      this.syncInFlight = false;
      if (this.connection.connected) {
        if (this.paused) {
          this.setStatus("paused");
        } else if (this.resyncBlocked) {
          this.setStatus("conflict");
        } else {
          this.setStatus(this.queue.size() > 0 ? "syncing" : "synced");
        }
      }
    }
  }

  private sendAndWait(
    item: QueuedChange,
    bytes?: Uint8Array,
    inlinePayload?: string,
  ): Promise<AckResult | null> {
    if (!this.connection.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timeoutMs =
        bytes && bytes.byteLength > 0 ? CHUNKED_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }, timeoutMs);
      this.pendingAcks.set(item.operationId, { resolve, timer });
      item.inFlight = true;
      // The watcher stamps changes without a deviceId; the authenticated
      // device is known only at send time.
      const wireChange: Change = {
        ...item,
        deviceId: this.state.deviceId ?? "",
        ...(inlinePayload !== undefined
          ? { content: undefined, payload: inlinePayload }
          : {}),
      };
      if (!this.connection.sendChange(wireChange, bytes)) {
        clearTimeout(timer);
        this.pendingAcks.delete(item.operationId);
        item.inFlight = false;
        resolve(null);
      }
    });
  }

  private settleAck(operationId: string, result: AckResult): void {
    const pending = this.pendingAcks.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(operationId);
    const item = this.queue.get(operationId);
    if (item) item.inFlight = false;
    pending.resolve(result);
  }

  private clearPendingAcks(): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "retry" });
    }
    this.pendingAcks.clear();
  }

  private handleRetry(operationId: string, message: string): void {
    this.settleAck(operationId, { status: "retry" });
    this.onNotice(`SyncVault: upload will retry: ${message}`, 6000);
  }

  private handleRejected(operationId: string, code: string, message: string): void {
    // Unblock any in-flight ack wait so the flush loop can move on immediately.
    const pending = this.pendingAcks.get(operationId);
    if (pending) this.settleAck(operationId, { status: "rejected" });
    const item = this.queue.get(operationId);
    if (item) {
      void this.queue.removeDropped(operationId);
      if (item.stagedFile) void this.staging?.remove(item.stagedFile);
      this.onNotice(`SyncVault: skipped "${item.path}": ${message}`, 6000);
    }
  }

  private setStatus(status: SyncStatus): void {
    if (this.statusValue !== status) {
      this.statusValue = status;
      this.onStatus(status);
    }
  }
}
