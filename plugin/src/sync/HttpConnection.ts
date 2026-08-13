import type { Change } from "@syncvault/shared";
import type { ApiError, SyncClient } from "../api/SyncClient";
import type { Connection, ConnectionCallbacks } from "./SyncConnection";
import { SyncState } from "../state/SyncState";

function isApiError(e: unknown): e is ApiError {
  const maybe = e as ApiError;
  return (
    maybe instanceof Error &&
    typeof maybe.status === "number" &&
    typeof maybe.code === "string"
  );
}

/**
 * HTTP polling transport. Obsidian's `requestUrl` (Electron/Capacitor native)
 * is more dependable across desktop + mobile than renderer WebSockets, so this
 * is the default transport; the WebSocket transport remains available.
 */
export class HttpConnection implements Connection {
  private connectedFlag = false;

  // HTTP knows nothing about broadcast order: a push accept replies with the
  // server's global revision, which may skip interleaved remote changes. The
  // cursor advances only when those changes are actually applied.
  advanceCursorOnAccept = false;

  constructor(
    private state: SyncState,
    private client: SyncClient,
    private callbacks: ConnectionCallbacks,
  ) {}

  get connected(): boolean {
    return this.connectedFlag && this.state.connected;
  }

  connect(): void {
    this.connectedFlag = true;
    this.callbacks.onStatusChange("open");
  }

  disconnect(): void {
    this.connectedFlag = false;
    this.callbacks.onStatusChange("idle");
  }

  async pull(since: number): Promise<{
    currentRevision: number;
    changes: Change[];
    resyncRequired: boolean;
  }> {
    try {
      const r = await this.client.pullChanges(
        this.state.accountId ?? "",
        this.state.vaultId ?? "",
        this.state.deviceId ?? "",
        this.state.deviceToken ?? "",
        since,
      );
      if (r.resyncRequired) {
        this.callbacks.onResyncRequired?.();
      }
      this.callbacks.onAuthed?.();
      return { currentRevision: r.currentRevision, changes: r.changes, resyncRequired: r.resyncRequired };
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        this.callbacks.onAuthFailure?.("authentication expired; reconnect the vault");
      } else if (isApiError(e) && e.code === "CLIENT_UPGRADE_REQUIRED") {
        this.callbacks.onError?.(
          "this vault uses SyncVault v2 content; update the plugin",
        );
      }
      throw e;
    }
  }

  sendChange(change: Change, bytes?: Uint8Array): boolean {
    const p = this.params();
    void this.push(change, bytes, p);
    return true;
  }

  sendAck(revision: number): boolean {
    const p = this.params();
    void this.client
      .sendAck(p.accountId, p.vaultId, p.deviceId, p.token, revision)
      .catch(() => undefined);
    return true;
  }

  async fetchContent(change: Change): Promise<Uint8Array | null> {
    if (change.content === undefined || change.revision < 1) return null;
    const p = this.params();
    try {
      return await this.client.downloadContent(
        p.accountId,
        p.vaultId,
        p.deviceId,
        p.token,
        change.revision,
        change.content,
      );
    } catch (e) {
      // A 401 here is an auth problem, not corrupt content: it must feed the
      // retry/auth path, not look like an apply failure.
      if (isApiError(e) && e.status === 401) {
        this.callbacks.onAuthFailure?.("authentication expired; reconnect the vault");
        return null;
      }
      this.callbacks.onError?.(`content download failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async push(
    change: Change,
    bytes: Uint8Array | undefined,
    p: { accountId: string; vaultId: string; deviceId: string; token: string },
  ): Promise<void> {
    try {
      const result =
        change.content !== undefined && bytes !== undefined
          ? await this.client.uploadContent(p.accountId, p.vaultId, p.deviceId, p.token, change, bytes)
          : await this.client.pushChange(p.accountId, p.vaultId, p.deviceId, p.token, change);
      if (result === null) {
        this.callbacks.onRetry?.(change.operationId, "content upload failed");
        return;
      }
      this.callbacks.onAuthed?.();
      if (result.status === "accepted") {
        this.callbacks.onAccepted(change.operationId, result.revision);
      } else {
        this.callbacks.onConflict({
          operationId: change.operationId,
          path: result.path,
          conflictPath: result.conflictPath,
          serverRevision: result.serverRevision,
        });
      }
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        this.callbacks.onRetry?.(change.operationId, e.message);
        this.callbacks.onAuthFailure?.("authentication expired; reconnect the vault");
        return;
      }
      if (isApiError(e) && e.code === "RESYNC_REQUIRED") {
        // History behind the retention window: keep the change queued and ask
        // the user to recover; never drop local data on a server 4xx.
        this.callbacks.onResyncRequired?.();
        this.callbacks.onError?.(e.message);
        return;
      }
      if (isApiError(e) && e.status >= 400 && e.status < 500) {
        // Permanent rejection (payload required, bad path, too large):
        // drop the change and keep sync moving instead of retrying forever.
        this.callbacks.onRejected?.(change.operationId, e.code, e.message);
        return;
      }
      this.callbacks.onRetry?.(change.operationId, (e as Error).message);
      this.callbacks.onError?.(`push failed: ${(e as Error).message}`);
    }
  }

  private params(): { accountId: string; vaultId: string; deviceId: string; token: string } {
    return {
      accountId: this.state.accountId ?? "",
      vaultId: this.state.vaultId ?? "",
      deviceId: this.state.deviceId ?? "",
      token: this.state.deviceToken ?? "",
    };
  }
}