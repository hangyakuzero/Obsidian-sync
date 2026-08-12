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

const HTTP_ACK_TIMEOUT_MS = 30_000;

/**
 * HTTP polling transport. Obsidian's `requestUrl` (Electron/Capacitor native)
 * is more dependable across desktop + mobile than renderer WebSockets, so this
 * is the default transport; the WebSocket transport remains available.
 */
export class HttpConnection implements Connection {
  private connectedFlag = false;

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
    const r = await this.client.pullChanges(
      this.state.accountId ?? "",
      this.state.vaultId ?? "",
      this.state.deviceId ?? "",
      this.state.deviceToken ?? "",
      since,
    );
    return { currentRevision: r.currentRevision, changes: r.changes, resyncRequired: r.resyncRequired };
  }

  sendChange(change: Change): boolean {
    const p = this.params();
    void this.push(change, p);
    return true;
  }

  sendAck(revision: number): boolean {
    const p = this.params();
    void this.client
      .sendAck(p.accountId, p.vaultId, p.deviceId, p.token, revision)
      .catch(() => undefined);
    return true;
  }

  private async push(
    change: Change,
    p: { accountId: string; vaultId: string; deviceId: string; token: string },
  ): Promise<void> {
    const timeout = setTimeout(() => {
      // the engine's own pending-ack window handles the timeout bookkeeping
    }, HTTP_ACK_TIMEOUT_MS);
    try {
      const result = await this.client.pushChange(p.accountId, p.vaultId, p.deviceId, p.token, change);
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
      clearTimeout(timeout);
      if (isApiError(e) && e.status >= 400 && e.status < 500 && e.code !== "UNAUTHORIZED") {
        // Permanent rejection (payload required, bad path, too large):
        // drop the change and keep sync moving instead of retrying forever.
        this.callbacks.onRejected?.(change.operationId, e.code, e.message);
        return;
      }
      this.callbacks.onError(`push failed: ${(e as Error).message}`);
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