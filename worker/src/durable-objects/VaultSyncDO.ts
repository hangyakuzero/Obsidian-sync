import { DurableObject } from "cloudflare:workers";
import { Change, ClientMessage, ServerMessage, normalizePath, MAX_FILE_BYTES, RETENTION_MS } from "@syncvault/shared";
import { ApiError } from "../errors";
import type { Env } from "../env";

const CHANGE_BATCH = 100;
const DEVICE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAYLOAD_BASE64 = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 16;

interface Attached {
  deviceId?: string;
  accountId?: string;
  authed: boolean;
}

export class VaultSyncDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS vault_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          current_revision INTEGER NOT NULL,
          min_retained_revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_seen_at INTEGER NOT NULL,
          last_ack_revision INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS changes (
          revision INTEGER PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          device_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          path TEXT NOT NULL,
          old_path TEXT,
          base_revision INTEGER NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS path_state (
          path TEXT PRIMARY KEY,
          last_revision INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS operation_receipts (
          operation_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_changes_created ON changes(created_at);
        INSERT OR IGNORE INTO vault_state (id, current_revision, min_retained_revision) VALUES (1, 0, 1);
      `);
    });
  }

  async initVault(): Promise<void> {
    // no-op: schema + seed run in constructor; kept for idempotent RPC
  }

  async registerDevice(deviceId: string, name: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (device_id, name, last_seen_at, last_ack_revision)
       VALUES (?, ?, ?, 0)
       ON CONFLICT(device_id) DO UPDATE SET name = excluded.name`,
      deviceId,
      (name || "device").slice(0, 100),
      Date.now(),
    );
  }

  async status(): Promise<{
    currentRevision: number;
    minRetainedRevision: number;
    devices: { deviceId: string; name: string; lastSeenAt: number; lastAckRevision: number }[];
  }> {
    const state = this.stateRow();
    const devices = this.ctx.storage.sql
      .exec<{ device_id: string; name: string; last_seen_at: number; last_ack_revision: number }>(
        "SELECT device_id, name, last_seen_at, last_ack_revision FROM devices ORDER BY device_id",
      )
      .toArray();
    return {
      currentRevision: state.current_revision,
      minRetainedRevision: state.min_retained_revision,
      devices: devices.map((d) => ({
        deviceId: d.device_id,
        name: d.name,
        lastSeenAt: d.last_seen_at,
        lastAckRevision: d.last_ack_revision,
      })),
    };
  }

  async submitChange(
    change: Change,
    authedDeviceId: string,
  ): Promise<{ status: "accepted"; revision: number } | { status: "conflict"; path: string; conflictPath?: string; serverRevision: number }> {
    if (change.deviceId !== authedDeviceId) {
      throw new ApiError("UNAUTHORIZED", "change deviceId does not match authenticated device");
    }
    if (!change.operationId || change.operationId.length > 100) {
      throw new ApiError("BAD_REQUEST", "missing operationId");
    }
    const path = normalizePath(change.path);
    const receipt = this.getReceipt(change.operationId);
    if (receipt !== null) {
      return { status: "accepted", revision: receipt };
    }
    const conflict = this.detectConflict(change, path);
    if (conflict) {
      if (conflict.conflictPath) {
        const revision = this.commitCopy(conflict.conflictPath, change);
        const committed = this.getChangeByRevision(revision);
        if (committed) this.broadcast(this.rowToChange(committed), undefined);
      }
      return { status: "conflict", path, conflictPath: conflict.conflictPath, serverRevision: conflict.serverRevision };
    }
    const revision = this.commit(change, path);
    this.broadcast(change, authedDeviceId);
    return { status: "accepted", revision };
  }

  async ack(deviceId: string, revision: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO devices (device_id, name, last_seen_at, last_ack_revision)
       VALUES (?, '', ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_ack_revision = MAX(last_ack_revision, excluded.last_ack_revision)`,
      deviceId,
      Date.now(),
      revision,
    );
  }

  async changesAfter(lastRevision: number): Promise<Change[]> {
    return this.ctx.storage.sql
      .exec<ChangeRow>(
        "SELECT * FROM changes WHERE revision > ? ORDER BY revision LIMIT ?",
        lastRevision,
        CHANGE_BATCH,
      )
      .toArray()
      .map((r) => this.rowToChange(r));
  }

  async alarm(): Promise<void> {
    this.runGarbageCollection();
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  async runGarbageCollection(): Promise<void> {
    this.garbageCollect();
  }

  private garbageCollect(): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM devices WHERE last_seen_at < ?",
        now - DEVICE_STALE_MS,
      );
      const active = this.ctx.storage.sql
        .exec<{ min_ack: number | null }>(
          "SELECT MIN(last_ack_revision) AS min_ack FROM devices WHERE last_seen_at >= ?",
          now - DEVICE_STALE_MS,
        )
        .toArray()[0]?.min_ack ?? null;
      if (active !== null) {
        this.ctx.storage.sql.exec("DELETE FROM changes WHERE revision <= ?", active);
      }
      this.ctx.storage.sql.exec("DELETE FROM changes WHERE created_at < ?", now - RETENTION_MS);
      const minRemaining = this.ctx.storage.sql
        .exec<{ min_rev: number | null }>("SELECT MIN(revision) AS min_rev FROM changes")
        .toArray()[0]?.min_rev ?? null;
      const current = this.stateRow().current_revision;
      const minRetained = minRemaining === null ? current + 1 : minRemaining;
      this.ctx.storage.sql.exec(
        "UPDATE vault_state SET min_retained_revision = ? WHERE id = 1",
        minRetained,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const accountId = url.searchParams.get("accountId") ?? "";
    const deviceId = url.searchParams.get("deviceId") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ deviceId, accountId, authed: false } satisfies Attached);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      ws.close(4400, "text messages only");
      return;
    }
    let parsed: ClientMessage | ClientMessage[];
    try {
      parsed = JSON.parse(message);
    } catch {
      ws.close(4400, "invalid JSON");
      return;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) await this.handleClientMessage(ws, item);
      return;
    }
    await this.handleClientMessage(ws, parsed);
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    const attached = ws.deserializeAttachment() as Attached | null;
    if (!attached?.authed) {
      if (msg.type !== "hello") {
        ws.close(4401, "authentication required");
        return;
      }
      await this.handleHello(ws, msg);
      return;
    }
    try {
      switch (msg.type) {
        case "change": {
          const result = await this.submitChange(msg.change, attached.deviceId!);
          this.touch(attached.deviceId!);
          if (result.status === "accepted") {
            this.send(ws, { type: "accepted", operationId: msg.change.operationId, revision: result.revision });
          } else {
            this.send(ws, {
              type: "conflict",
              operationId: msg.change.operationId,
              path: result.path,
              conflictPath: result.conflictPath,
              serverRevision: result.serverRevision,
            });
          }
          break;
        }
        case "ack":
          this.touch(attached.deviceId!);
          await this.ack(attached.deviceId!, msg.revision);
          break;
        default:
          ws.close(4400, "unsupported message");
      }
    } catch (e) {
      const err = e as ApiError;
      this.send(ws, { type: "error", code: err.code ?? "INTERNAL", message: err.message ?? "internal error" });
    }
  }

  private async handleHello(ws: WebSocket, msg: Extract<ClientMessage, { type: "hello" }>): Promise<void> {
    const ok = await this.env.ACCOUNT_DO
      .getByName(msg.accountId)
      .verifyDevice(msg.accountId, msg.deviceId, msg.token, msg.vaultId);
    if (!ok) {
      ws.close(4401, "authentication failed");
      return;
    }
    const state = this.stateRow();
    if (msg.lastRevision > state.current_revision) {
      ws.close(4402, "lastRevision ahead of server");
      return;
    }
    const attached: Attached = { deviceId: msg.deviceId, accountId: msg.accountId, authed: true };
    ws.serializeAttachment(attached);
    this.touch(msg.deviceId);
    this.registerDevice(msg.deviceId, "");
    // A client at revision R needs revisions R+1..: if the retained floor is
    // above R+1, part of that range was already garbage-collected.
    const resyncRequired = msg.lastRevision < state.min_retained_revision - 1;
    this.send(ws, { type: "welcome", serverRevision: state.current_revision, resyncRequired });
    if (resyncRequired) {
      ws.close(4001, "resync required");
      return;
    }
    await this.catchUp(ws, msg.lastRevision);
  }

  private async catchUp(ws: WebSocket, lastRevision: number): Promise<void> {
    let cursor = lastRevision;
    for (;;) {
      const rows = this.ctx.storage.sql
        .exec<ChangeRow>("SELECT * FROM changes WHERE revision > ? ORDER BY revision LIMIT ?", cursor, CHANGE_BATCH)
        .toArray();
      if (rows.length === 0) return;
      this.send(ws, {
        type: "batch",
        items: rows.map((r) => ({ type: "change", change: this.rowToChange(r) })),
      });
      cursor = rows[rows.length - 1].revision;
      if (rows.length < CHANGE_BATCH) return;
    }
  }

  private detectConflict(
    change: Change,
    path: string,
  ): { serverRevision: number; conflictPath?: string } | null {
    const pathRev = this.pathRevision(path);
    switch (change.operation) {
      case "create":
      case "update": {
        if (change.payload !== undefined && change.payload.length > MAX_PAYLOAD_BASE64) {
          throw new ApiError("PAYLOAD_TOO_LARGE", "file exceeds size limit");
        }
        if (pathRev !== null && pathRev > change.baseRevision) {
          return { serverRevision: pathRev, conflictPath: this.freshConflictPath(path, change) };
        }
        return null;
      }
      case "delete": {
        if (pathRev !== null && pathRev > change.baseRevision) {
          return { serverRevision: pathRev };
        }
        return null;
      }
      case "rename": {
        const newPath = normalizePath(change.oldPath ?? "");
        if (pathRev !== null && pathRev > change.baseRevision) {
          return { serverRevision: pathRev };
        }
        const newPathRev = this.pathRevision(newPath);
        if (newPathRev !== null && newPathRev > change.baseRevision) {
          return { serverRevision: newPathRev };
        }
        return null;
      }
      default:
        throw new ApiError("BAD_REQUEST", `unknown operation: ${change.operation}`);
    }
  }

  private commit(change: Change, path: string): number {
    const state = this.stateRow();
    const revision = state.current_revision + 1;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO changes (revision, operation_id, device_id, operation, path, old_path, base_revision, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision,
        change.operationId,
        change.deviceId,
        change.operation,
        path,
        change.oldPath ? normalizePath(change.oldPath) : null,
        change.baseRevision,
        change.payload ?? null,
        Date.now(),
      );
      if (change.operation === "rename") {
        const newPath = normalizePath(change.oldPath!);
        this.setPathState(path, revision, true);
        this.setPathState(newPath, revision, false);
      } else if (change.operation === "delete") {
        this.setPathState(path, revision, true);
      } else {
        this.setPathState(path, revision, false);
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO operation_receipts (operation_id, revision) VALUES (?, ?)",
        change.operationId,
        revision,
      );
      this.ctx.storage.sql.exec("UPDATE vault_state SET current_revision = ? WHERE id = 1", revision);
    });
    return revision;
  }

  private broadcast(change: Change, exceptDeviceId: string | undefined): void {
    const message: ServerMessage = { type: "change", change };
    for (const ws of this.ctx.getWebSockets()) {
      const attached = ws.deserializeAttachment() as Attached | null;
      if (!attached?.authed) continue;
      if (attached.deviceId === exceptDeviceId) continue;
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // socket is gone; close handler cleans up
      }
    }
  }

  private commitCopy(conflictPath: string, original: Change): number {
    const copy: Change = {
      operationId: `cnf_${original.operationId}`,
      revision: 0,
      deviceId: original.deviceId,
      path: conflictPath,
      operation: "create",
      baseRevision: original.baseRevision,
      timestamp: original.timestamp || Date.now(),
      payload: original.payload,
    };
    const revision = this.commit(copy, conflictPath);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO operation_receipts (operation_id, revision) VALUES (?, ?)",
      original.operationId,
      revision,
    );
    return revision;
  }

  private getChangeByRevision(revision: number): ChangeRow | null {
    return (
      this.ctx.storage.sql
        .exec<ChangeRow>("SELECT * FROM changes WHERE revision = ?", revision)
        .one() ?? null
    );
  }

  private freshConflictPath(path: string, change: Change): string {
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
      const candidate = `${dir}${stem} (conflict-${change.deviceId}-${stamp})${suffix}${ext}`;
      if (this.pathRevision(candidate) === null) return candidate;
    }
    throw new ApiError("CONFLICT", "could not allocate conflict path");
  }

  private getReceipt(operationId: string): number | null {
    const row = this.ctx.storage.sql
      .exec<{ revision: number }>("SELECT revision FROM operation_receipts WHERE operation_id = ?", operationId)
      .toArray()[0];
    return row?.revision ?? null;
  }

  private pathRevision(path: string): number | null {
    const row = this.ctx.storage.sql
      .exec<{ last_revision: number }>("SELECT last_revision FROM path_state WHERE path = ?", path)
      .toArray()[0];
    return row?.last_revision ?? null;
  }

  private setPathState(path: string, revision: number, deleted: boolean): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO path_state (path, last_revision, deleted) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET last_revision = excluded.last_revision, deleted = excluded.deleted`,
      path,
      revision,
      deleted ? 1 : 0,
    );
  }

  private stateRow(): { current_revision: number; min_retained_revision: number } {
    const row = this.ctx.storage.sql
      .exec<{ current_revision: number; min_retained_revision: number }>(
        "SELECT current_revision, min_retained_revision FROM vault_state WHERE id = 1",
      )
      .one();
    if (!row) throw new ApiError("INTERNAL", "vault state missing");
    return row;
  }

  private rowToChange(row: ChangeRow): Change {
    return {
      operationId: row.operation_id,
      revision: row.revision,
      deviceId: row.device_id,
      path: row.path,
      operation: row.operation as Change["operation"],
      oldPath: row.old_path ?? undefined,
      baseRevision: row.base_revision,
      timestamp: row.created_at,
      payload: row.payload ?? undefined,
    };
  }

  private touch(deviceId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE devices SET last_seen_at = ? WHERE device_id = ?",
      Date.now(),
      deviceId,
    );
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket closing
    }
  }
}

interface ChangeRow extends Record<string, SqlStorageValue> {
  revision: number;
  operation_id: string;
  device_id: string;
  operation: string;
  path: string;
  old_path: string | null;
  base_revision: number;
  payload: string | null;
  created_at: number;
}