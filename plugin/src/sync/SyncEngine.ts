import { Change, fromBase64, isValidBase64, MAX_FILE_BYTES, normalizePath, toBase64 } from "@syncvault/shared";
import { SyncState, QueuedChange } from "../state/SyncState";
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
const DEFAULT_POLL_INTERVAL_MS = 4000;

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
    this.setStatus("idle");
  }

  async resetForRebuild(): Promise<void> {
    this.stop();
    this.ackTarget = 0;
    await this.queue.clear();
  }

  /**
   * Resume after a pause (or simply trigger a sync round): clears the paused
   * flag, (re)connects and runs one poll immediately.
   */
  async resume(): Promise<void> {
    this.paused = false;
    if (this.statusValue === "paused") this.setStatus("syncing");
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
      const result = await this.connection.pull(this.state.lastRevision);
      if (result.resyncRequired) {
        this.onNotice(
          "SyncVault: local history is older than the server retention window. Resync is not supported yet.",
          10000,
        );
        this.setStatus("conflict");
        return;
      }
      if (result.changes.length > 0) this.setStatus("downloading");
      for (const change of result.changes) {
        await this.applyRemoteChange(change);
        if (this.paused) break;
      }
      await this.maybeSeed();
      await this.flushQueue();
      if (this.state.pendingChanges.length === 0) {
        this.setStatus(this.connection.connected ? "synced" : "offline");
      }
    } catch {
      this.setStatus(this.connection.connected ? "offline" : "offline");
    } finally {
      this.polling = false;
    }
  }

  private handleConnectionStatus(status: ConnectionStatus): void {
    if (status === "offline") {
      this.setStatus("offline");
    } else if (status === "open" && this.statusValue === "offline") {
      this.setStatus("synced");
    }
  }

  private handleAuthFailure(message: string): void {
    this.connection.disconnect();
    this.clearPendingAcks();
    this.paused = true;
    this.setStatus("paused");
    this.onNotice(`SyncVault: sync paused — ${message}. Reconnect the vault to continue.`, 10000);
  }

  private async handleWelcome(serverRevision: number, resyncRequired: boolean): Promise<void> {
    if (resyncRequired) {
      this.onNotice("SyncVault: local history is older than the server retention window. Resync is not supported yet.", 10000);
      this.setStatus("conflict");
      return;
    }
    this.setStatus("synced");
    if (!this.paused) await this.flushQueue();
  }

  private async applyRemoteChange(change: Change): Promise<void> {
    if (this.statusValue === "idle") this.setStatus("downloading");
    const paths = change.oldPath ? [change.path, change.oldPath] : [change.path];
    // Suppress vault events from these paths so applied changes never loop back into the queue.
    this.watcher.suppress(paths);
    try {
      await this.apply(change);
      // Remember paths whose content we seeded from the server so the initial
      // scan never re-uploads them as local-only files.
      await this.state.markApplied(change.path, change.oldPath);
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
    } finally {
      this.watcher.releaseAll();
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
      let payload: string | undefined;
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
        payload = toBase64(new Uint8Array(bytes));
      }
      await this.queue.enqueue({
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: f.path,
        operation: "create",
        baseRevision: this.state.lastRevision,
        timestamp: Date.now(),
        payload,
      });
    }
    await this.state.markSeeded();
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
    switch (change.operation) {
      case "create":
      case "update": {
        if (typeof change.payload !== "string") throw new Error("missing payload");
        if (!isValidBase64(change.payload)) throw new Error("invalid payload");
        await this.vault.write(normalizePath(change.path), fromBase64(change.payload));
        return;
      }
      case "delete":
        await this.vault.remove(normalizePath(change.path));
        return;
      case "rename": {
        if (!change.oldPath) throw new Error("rename missing oldPath");
        await this.vault.rename(normalizePath(change.oldPath), normalizePath(change.path));
        return;
      }
    }
  }

  private async flushQueue(): Promise<void> {
    if (!this.connection.connected) return;
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.setStatus(this.queue.size() > 0 ? "uploading" : this.statusValue);
    try {
      for (const item of [...this.queue.items]) {
        if (!this.connection.connected) break;
        const result = await this.sendAndWait(item);
        if (result === null) break;
        if (result.status === "retry") break;
        if (result.status === "rejected") {
          // permanently rejected (e.g. legacy payload-less seed) — already
          // removed from the queue by handleRejected; do not advance the cursor
          continue;
        }
        await this.queue.remove(item.operationId);
        if (result.status === "accepted") {
          await this.state.setLastRevision(result.revision);
        } else {
          // The server committed the conflicting version as a conflict copy and
          // broadcast it to this device; the copy is applied via applyRemoteChange.
          this.setStatus("conflict");
        }
      }
    } finally {
      this.syncInFlight = false;
      if (this.connection.connected) this.setStatus(this.queue.size() > 0 ? "syncing" : "synced");
    }
  }

  private sendAndWait(
    item: QueuedChange,
  ): Promise<AckResult | null> {
    if (!this.connection.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(item.operationId, { resolve, timer });
      // The watcher stamps changes without a deviceId; the authenticated
      // device is known only at send time.
      const wireChange: Change = { ...item, deviceId: this.state.deviceId ?? "" };
      if (!this.connection.sendChange(wireChange)) {
        clearTimeout(timer);
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }
    });
  }

  private settleAck(operationId: string, result: AckResult): void {
    const pending = this.pendingAcks.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(operationId);
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
      void this.queue.remove(operationId);
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
