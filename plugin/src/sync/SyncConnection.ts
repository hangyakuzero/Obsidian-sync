import { Change, ClientMessage, ServerMessage } from "@syncvault/shared";

export type ConnectionStatus = "idle" | "connecting" | "open" | "offline";

export interface Connection {
  connected: boolean;
  connect(): void;
  disconnect(): void;
  sendChange(change: Change): boolean;
  sendAck(revision: number): boolean;
  pull(
    since: number,
  ): Promise<{ currentRevision: number; changes: Change[]; resyncRequired: boolean }>;
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
  onRemoteChange(change: Change): void;
  onAccepted(operationId: string, revision: number): void;
  onConflict(opts: { operationId: string; path: string; conflictPath?: string; serverRevision: number }): void;
  onRejected?(operationId: string, code: string, message: string): void;
  onError(message: string): void;
  onStatusChange(status: ConnectionStatus): void;
}

const RETRY_BACKOFFS = [2000, 5000, 10_000, 30_000];
const FATAL_CLOSE_REASONS = new Set([4001, 4400, 4401, 4402]);

export class SyncConnection implements Connection {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "idle";
  private manualClose = false;
  private retryIndex = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private params: () => ConnectionParams,
    private callbacks: ConnectionCallbacks,
  ) {}

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
        this.send({ type: "hello", accountId: p.accountId, vaultId: p.vaultId, deviceId: p.deviceId, token: p.token, lastRevision: p.getLastRevision() });
      };
      ws.onmessage = (event) => this.dispatch(event);
      ws.onclose = (event) => this.handleClose(event);
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

  sendChange(change: Change): boolean {
    return this.send({ type: "change", change });
  }

  sendAck(revision: number): boolean {
    return this.send({ type: "ack", revision });
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
        this.callbacks.onWelcome(msg.serverRevision, msg.resyncRequired);
        break;
      case "change":
        this.callbacks.onRemoteChange(msg.change);
        break;
      case "accepted":
        this.callbacks.onAccepted(msg.operationId, msg.revision);
        break;
      case "conflict":
        this.callbacks.onConflict({
          operationId: msg.operationId,
          path: msg.path,
          conflictPath: msg.conflictPath,
          serverRevision: msg.serverRevision,
        });
        break;
      case "error":
        this.callbacks.onError(msg.message);
        break;
    }
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