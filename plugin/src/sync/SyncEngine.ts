import { Change, fromBase64, normalizePath } from "@syncvault/shared";
import { SyncState, QueuedChange } from "../state/SyncState";
import { ChangeQueue } from "./ChangeQueue";
import { VaultWatcher } from "../vault/VaultWatcher";
import { SyncConnection, ConnectionStatus, ConnectionCallbacks } from "./SyncConnection";

export type SyncStatus = "idle" | "syncing" | "downloading" | "uploading" | "conflict" | "offline" | "synced";

export interface VaultOps {
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface Connection {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  sendChange(change: Change): boolean;
  sendAck(revision: number): boolean;
}

interface PendingAck {
  resolve: (result: { accepted: true; revision: number } | { accepted: false; conflictPath?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ACK_TIMEOUT_MS = 30_000;

export class SyncEngine {
  private connection: Connection;
  private status: SyncStatus = "idle";
  private syncInFlight = false;
  private pendingAcks = new Map<string, PendingAck>();
  private ackTarget = 0;

  constructor(
    private state: SyncState,
    private queue: ChangeQueue,
    private watcher: VaultWatcher,
    private vault: VaultOps,
    private onStatus: (status: SyncStatus) => void,
    private onNotice: (message: string, timeout?: number) => void,
    connectionFactory?: (handlers: ConnectionCallbacks) => Connection,
  ) {
    const handlers: ConnectionCallbacks = {
      onWelcome: (serverRevision, resyncRequired) => this.handleWelcome(serverRevision, resyncRequired),
      onRemoteChange: (change) => void this.applyRemoteChange(change),
      onAccepted: (operationId, revision) => this.settleAck(operationId, { accepted: true, revision }),
      onConflict: (c) =>
        this.settleAck(c.operationId, { accepted: false, conflictPath: c.conflictPath }),
      onError: (message) => this.onNotice(`SyncVault: ${message}`, 6000),
      onStatusChange: (status) => this.handleConnectionStatus(status),
    };
    this.connection =
      connectionFactory?.(handlers) ??
      new SyncConnection(
        {
          serverUrl: state.serverUrl,
          accountId: state.accountId ?? "",
          vaultId: state.vaultId ?? "",
          deviceId: state.deviceId ?? "",
          token: state.deviceToken ?? "",
          getLastRevision: () => this.state.lastRevision,
        },
        handlers,
      );
  }

  start(): void {
    if (!this.state.connected) return;
    this.connection.connect();
  }

  stop(): void {
    this.connection.disconnect();
    this.setStatus("idle");
  }

  get syncing(): boolean {
    return this.syncInFlight;
  }

  async syncNow(): Promise<void> {
    if (!this.state.connected) {
      this.onNotice("SyncVault: not configured", 4000);
      return;
    }
    this.connection.connect();
    await this.flushQueue();
  }

  private handleConnectionStatus(status: ConnectionStatus): void {
    if (status === "offline") {
      this.setStatus("offline");
    } else if (status === "open" && this.status === "offline") {
      this.setStatus("synced");
    }
  }

  private async handleWelcome(serverRevision: number, resyncRequired: boolean): Promise<void> {
    if (resyncRequired) {
      this.onNotice("SyncVault: local history is older than the server retention window. Resync is not supported yet.", 10000);
      this.setStatus("conflict");
      return;
    }
    this.setStatus("synced");
    void this.flushQueue();
  }

  private async applyRemoteChange(change: Change): Promise<void> {
    if (this.status === "idle") this.setStatus("downloading");
    const paths = change.oldPath ? [change.path, change.oldPath] : [change.path];
    // Suppress vault events from these paths so applied changes never loop back into the queue.
    this.watcher.suppress(paths);
    try {
      await this.apply(change);
    } catch (e) {
      this.onNotice(`SyncVault: failed to apply ${change.path}: ${(e as Error).message}`, 8000);
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

  private async apply(change: Change): Promise<void> {
    switch (change.operation) {
      case "create":
      case "update": {
        if (!change.payload) throw new Error("missing payload");
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
    this.setStatus(this.queue.size() > 0 ? "uploading" : this.status);
    try {
      for (const item of [...this.queue.items]) {
        if (!this.connection.connected) break;
        const result = await this.sendAndWait(item);
        if (result === null) break;
        await this.queue.remove(item.operationId);
        if (result.accepted) {
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
  ): Promise<{ accepted: true; revision: number } | { accepted: false; conflictPath?: string } | null> {
    if (!this.connection.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(item.operationId, { resolve, timer });
      if (!this.connection.sendChange(item)) {
        clearTimeout(timer);
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }
    });
  }

  private settleAck(
    operationId: string,
    result: { accepted: true; revision: number } | { accepted: false; conflictPath?: string },
  ): void {
    const pending = this.pendingAcks.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(operationId);
    pending.resolve(result);
  }

  private setStatus(status: SyncStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.onStatus(status);
    }
  }
}