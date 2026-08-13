import { Change, ClientMessage, ServerMessage } from "@syncvault/shared";
import { CHUNK_CAPABILITY } from "@syncvault/shared";
import { SyncClient } from "../api/SyncClient";

export type ConnectionStatus = "idle" | "connecting" | "open" | "offline";

export interface Connection {
  connected: boolean;
  /**
   * Whether an `accepted` reply may advance the local cursor. True only for
   * transports whose broadcast ordering guarantees the pushing device has
   * already seen every earlier revision (WebSocket FIFO); HTTP is false —
   * interleaved remote revisions must be applied before the cursor moves.
   */
  advanceCursorOnAccept: boolean;
  connect(): void;
  disconnect(): void;
  sendChange(change: Change, bytes?: Uint8Array): boolean;
  sendAck(revision: number): boolean;
  pull(
    since: number,
  ): Promise<{ currentRevision: number; changes: Change[]; resyncRequired: boolean }>;
  /** Fetches and verifies the bytes behind a change's content reference. */
  fetchContent(change: Change): Promise<Uint8Array | null>;
}

export interface ConnectionParams {
  serverUrl: string;
  accountId: string;
  vaultId: string;
  deviceId: string;
  token: string;
  getLastRevision(): number;
}

export interface ConnectionCallbacks {
  onWelcome(serverRevision: number, resyncRequired: boolean): void;
  onRemoteChange(change: Change): void | Promise<void>;
  onAccepted(operationId: string, revision: number): void;
  onRejected?(operationId: string, code: string, message: string): void;
  onAuthFailure?(message: string): void;
  /** Any authenticated success (HTTP pull/push or WS welcome) resets the
   * consecutive-auth-failure counter so three separated 401s never pause. */
  onAuthed?(): void;
  onRetry?(operationId: string, message: string): void;
  onResyncRequired?(message?: string): void;
  onError(message: string): void;
  onStatusChange(status: ConnectionStatus): void;
}

const RETRY_BACKOFFS = [2000, 5000, 10_000, 30_000];
const FATAL_CLOSE_REASONS = new Set([4001, 4400, 4401, 4402, 4403]);

export class SyncConnection implements Connection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "idle";
  private manualClose = false;
  private retryIndex = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteChain: Promise<void> = Promise.resolve();
  private client: SyncClient | null = null;

  constructor(
    private params: () => ConnectionParams,
    private callbacks: ConnectionCallbacks,
  ) {}

  // WebSocket broadcasts arrive in server revision order on a single FIFO
  // socket, so an accepted reply always follows every earlier revision.
  advanceCursorOnAccept = true;

  // Realtime transport: changes arrive live via the socket; nothing to poll.
  async pull(): Promise<{ currentRevision: number; changes: Change[]; resyncRequired: boolean }> {
    return { currentRevision: 0, changes: [], resyncRequired: false };
  }

  get connected(): boolean {
    return this.status === "open";
  }

  connect(): void {
    if (this.status === "connecting" || this.status === "open") return;
    this.manualClose = false;
    this.setStatus("connecting");
    const url = this.wsUrl();
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        if (typeof ws !== "undefined" && ws !== this.ws) return;
        this.retryIndex = 0;
        const p = this.params();
        this.send({
          type: "hello",
          accountId: p.accountId,
          vaultId: p.vaultId,
          deviceId: p.deviceId,
          token: p.token,
          lastRevision: p.getLastRevision(),
          capabilities: [CHUNK_CAPABILITY],
        });
      };
      ws.onmessage = (event) => this.dispatch(event);
      ws.onclose = (event) => {
        // A stale socket closing after a reconnect must never take down the
        // current connection.
        if (ws !== this.ws) return;
        this.handleClose(event);
      };
      ws.onerror = () => {
        // onclose follows; nothing to do here
      };
    } catch {
      this.setStatus("offline");
      this.scheduleRetry();
    }
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.ws?.close(1000, "disconnect");
    } catch {
      // ignore
    }
    this.ws = null;
    this.setStatus("idle");
  }

  sendChange(change: Change, bytes?: Uint8Array): boolean {
    // Chunked content cannot travel over the socket; upload the bytes over
    // HTTP first, then announce the change on the socket for ordering.
    if (change.content !== undefined && bytes !== undefined) {
      this.uploadAndAnnounce(change, bytes);
      return true;
    }
    return this.send({ type: "change", change });
  }

  sendAck(revision: number): boolean {
    return this.send({ type: "ack", revision });
  }

  async fetchContent(change: Change): Promise<Uint8Array | null> {
    if (change.content === undefined || change.revision < 1) return null;
    return this.httpClient().downloadContent(
      this.params().accountId,
      this.params().vaultId,
      this.params().deviceId,
      this.params().token,
      change.revision,
      change.content,
    );
  }

  private async uploadAndAnnounce(change: Change, bytes: Uint8Array): Promise<void> {
    const p = this.params();
    try {
      const result = await this.httpClient().uploadContent(
        p.accountId,
        p.vaultId,
        p.deviceId,
        p.token,
        change,
        bytes,
      );
      if (result === null) {
        this.callbacks.onRetry?.(change.operationId, "content upload failed");
        return;
      }
      if (result.status === "accepted") {
        // Announcement still travels over the socket so the broadcast order
        // stays intact; the accepted reply will resolve the pending ack.
        this.send({ type: "change", change: { ...change, deviceId: p.deviceId } });
      }
    } catch (e) {
      this.callbacks.onRetry?.(change.operationId, (e as Error).message);
      this.callbacks.onError(`upload failed: ${(e as Error).message}`);
    }
  }

  private httpClient(): SyncClient {
    if (this.client === null) this.client = new SyncClient(this.params().serverUrl);
    return this.client;
  }

  private wsUrl(): string {
    const p = this.params();
    const wsBase = p.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    const q = new URLSearchParams({ accountId: p.accountId, deviceId: p.deviceId });
    return `${wsBase}/v1/vaults/${p.vaultId}/ws?${q.toString()}`;
  }

  private send(msg: ClientMessage): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private dispatch(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(event.data) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "batch") {
      for (const item of msg.items) this.handle(item);
      return;
    }
    this.handle(msg);
  }

  private handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.setStatus("open");
        this.callbacks.onAuthed?.();
        this.chain(() => this.callbacks.onWelcome(msg.serverRevision, msg.resyncRequired));
        break;
      case "change":
        this.chain(() => this.callbacks.onRemoteChange(msg.change));
        break;
      case "accepted":
        // Serialized behind every preceding remote application so the push
        // cursor optimization can never skip a revision the server broadcast.
        this.chain(() => this.callbacks.onAccepted(msg.operationId, msg.revision));
        break;
      case "error":
        this.callbacks.onError(msg.message);
        break;
    }
  }

  private chain(cb: () => void | Promise<void>): void {
    this.remoteChain = this.remoteChain.then(cb).catch(() => undefined);
  }

  private handleClose(event: CloseEvent): void {
    if (this.manualClose) return;
    if (FATAL_CLOSE_REASONS.has(event.code)) {
      this.ws = null;
      this.setStatus("offline");
      this.callbacks.onError(`connection closed: ${event.reason || `code ${event.code}`}`);
      return;
    }
    this.ws = null;
    this.setStatus("offline");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.manualClose || this.retryTimer !== null) return;
    const delay = RETRY_BACKOFFS[Math.min(this.retryIndex, RETRY_BACKOFFS.length - 1)];
    this.retryIndex += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.callbacks.onStatusChange(status);
    }
  }
}
