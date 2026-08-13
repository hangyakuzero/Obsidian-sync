import { DurableObject } from "cloudflare:workers";
import {
  Change,
  ClientMessage,
  ServerMessage,
  fromBase64,
  isValidBase64,
  isValidContentReference,
  isValidHash,
  normalizePath,
  pathCollisionKey,
  CHUNK_BYTES,
  CHUNK_CAPABILITY,
  MAX_FILE_BYTES,
  MAX_INLINE_BYTES,
  RETENTION_MS,
} from "@syncvault/shared";
import { ApiError } from "../errors";
import type { Env } from "../env";

const CHANGE_BATCH = 100;
const DEVICE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAYLOAD_BASE64 = Math.ceil((MAX_INLINE_BYTES * 4) / 3) + 16;
const UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
const OPERATION_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

interface Attached {
  deviceId?: string;
  accountId?: string;
  authed: boolean;
  capabilities?: string[];
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
          content_hash TEXT,
          byte_length INTEGER,
          chunk_count INTEGER,
          causal_parents TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS path_state (
          path TEXT PRIMARY KEY,
          last_revision INTEGER NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0,
          collision_key TEXT,
          content_hash TEXT,
          last_operation_id TEXT
        );
        CREATE TABLE IF NOT EXISTS operation_receipts (
          operation_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS upload_sessions (
          operation_id TEXT PRIMARY KEY,
          device_id TEXT NOT NULL,
          change_json TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          chunk_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS upload_chunks (
          operation_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (operation_id, chunk_index)
        );
        CREATE TABLE IF NOT EXISTS change_chunks (
          revision INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (revision, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_changes_created ON changes(created_at);
        INSERT OR IGNORE INTO vault_state (id, current_revision, min_retained_revision) VALUES (1, 0, 1);
      `);
      // Existing V1 vaults are upgraded in place. SQLite has no portable
      // ADD COLUMN IF NOT EXISTS, so ignore duplicate-column errors.
      for (const column of [
        "ALTER TABLE changes ADD COLUMN content_hash TEXT",
        "ALTER TABLE changes ADD COLUMN byte_length INTEGER",
        "ALTER TABLE changes ADD COLUMN chunk_count INTEGER",
        "ALTER TABLE changes ADD COLUMN causal_parents TEXT",
        "ALTER TABLE path_state ADD COLUMN collision_key TEXT",
        "ALTER TABLE path_state ADD COLUMN content_hash TEXT",
        "ALTER TABLE path_state ADD COLUMN last_operation_id TEXT",
      ]) {
        try { this.ctx.storage.sql.exec(column); } catch { /* already upgraded */ }
      }
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    });
  }

  async initVault(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
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
    opts: { strict?: boolean } = {},
  ): Promise<{ status: "accepted"; revision: number } | { status: "conflict"; path: string; conflictPath?: string; serverRevision: number }> {
    const strict = opts.strict ?? false;
    if (change.deviceId !== authedDeviceId) {
      throw new ApiError("UNAUTHORIZED", "change deviceId does not match authenticated device");
    }
    // HTTP pushes are the device's only liveness signal while it uploads
    // without pulling (the converge loop pushes between pulls).
    this.touch(authedDeviceId);
    if (!OPERATION_ID_RE.test(change.operationId ?? "")) {
      throw new ApiError("BAD_REQUEST", "missing operationId");
    }
    if (!Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0) {
      throw new ApiError("BAD_REQUEST", "invalid baseRevision");
    }
    // At-least-once retries resolve from the receipt before any state checks:
    // receipts are the only mechanism that survives history pruning, and a
    // client retrying a pruned operation must not be bounced with a resync.
    const receipt = this.getReceipt(change.operationId);
    if (receipt !== null) {
      return { status: "accepted", revision: receipt };
    }
    const state = this.stateRow();
    if (change.baseRevision > state.current_revision) {
      throw new ApiError("BAD_REQUEST", "baseRevision ahead of server");
    }
    // Protocol-v2 clients (marked via capabilities) get the strict check that
    // fails fast instead of mutating from a truncated baseline. Legacy clients
    // stay lenient: they cannot recover a pruned change log either way, so we
    // accept the mutation and let their next pull trigger the resync instead.
    if (strict && change.baseRevision < state.min_retained_revision - 1) {
      throw new ApiError("RESYNC_REQUIRED", "local history is older than the retention window");
    }
    if (change.causalParents !== undefined && (!Array.isArray(change.causalParents) ||
      change.causalParents.length > 100 || change.causalParents.some((id) => !OPERATION_ID_RE.test(id)))) {
      throw new ApiError("BAD_REQUEST", "invalid causalParents");
    }
    if (change.operation === "create" || change.operation === "update") {
      if (typeof change.payload !== "string" && !isValidContentReference(change.content)) {
        throw new ApiError("PAYLOAD_REQUIRED", "file content required");
      }
      if (change.content !== undefined && !isValidContentReference(change.content)) {
        throw new ApiError("BAD_REQUEST", "invalid content descriptor");
      }
      if (typeof change.payload === "string" && !isValidBase64(change.payload)) {
        throw new ApiError("BAD_REQUEST", "file content is not valid Base64");
      }
      if (typeof change.payload === "string" && (change.payload.length > MAX_PAYLOAD_BASE64 || fromBase64(change.payload).byteLength > MAX_INLINE_BYTES)) {
        throw new ApiError("PAYLOAD_TOO_LARGE", "file exceeds inline size limit; use chunked upload");
      }
    }
    let path: string;
    try {
      path = normalizePath(change.path);
      if (change.oldPath !== undefined) normalizePath(change.oldPath);
    } catch (error) {
      throw new ApiError("BAD_REQUEST", (error as Error).message);
    }
    // Retried/stale writes containing exactly the bytes already live are a
    // receipt-only success. This avoids both a false conflict and a redundant
    // revision without weakening different-content conflict protection.
    if ((change.operation === "create" || change.operation === "update") && change.content) {
      const live = this.pathState(path);
      if (live && !live.deleted && live.content_hash === change.content.hash && live.last_revision > change.baseRevision) {
        this.ctx.storage.sql.exec("INSERT INTO operation_receipts (operation_id, revision) VALUES (?, ?)", change.operationId, live.last_revision);
        return { status: "accepted", revision: live.last_revision };
      }
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
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    const committed = this.getChangeByRevision(revision);
    if (committed) this.broadcast(this.rowToChange(committed), authedDeviceId);
    return { status: "accepted", revision };
  }

  async ack(deviceId: string, revision: number): Promise<void> {
    const current = this.stateRow().current_revision;
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > current) {
      throw new ApiError("BAD_REQUEST", "invalid acknowledgement revision");
    }
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

  /** A single consistent pull read avoids status/read races between HTTP calls. */
  async syncSince(deviceId: string, cursor: number, capabilities: string[] = []): Promise<{
    currentRevision: number; minRetainedRevision: number; resyncRequired: boolean; changes: Change[];
  }> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError("BAD_REQUEST", "invalid cursor");
    const state = this.stateRow();
    this.touch(deviceId);
    if (cursor > state.current_revision || cursor < state.min_retained_revision - 1) {
      return { currentRevision: state.current_revision, minRetainedRevision: state.min_retained_revision, resyncRequired: true, changes: [] };
    }
    const rows = this.ctx.storage.sql
      .exec<ChangeRow>("SELECT * FROM changes WHERE revision > ? ORDER BY revision LIMIT ?", cursor, CHANGE_BATCH)
      .toArray();
    if (!capabilities.includes("chunks-v1") && rows.some((r) => r.content_hash !== null)) {
      throw new ApiError("CLIENT_UPGRADE_REQUIRED", "this vault contains chunked content; update SyncVault");
    }
    return { currentRevision: state.current_revision, minRetainedRevision: state.min_retained_revision, resyncRequired: false,
      changes: rows.map((r) => this.rowToChange(r)) };
  }

  async beginUpload(change: Change, authedDeviceId: string): Promise<{ uploaded: number[]; acceptedRevision?: number }> {
    if (!isValidContentReference(change.content)) throw new ApiError("BAD_REQUEST", "invalid content descriptor");
    const receipt = this.getReceipt(change.operationId);
    if (receipt !== null) return { uploaded: [], acceptedRevision: receipt };
    // Validate all operation invariants before accepting any bytes.
    await this.validateChangeForUpload(change, authedDeviceId);
    const old = this.ctx.storage.sql.exec<{ chunk_index: number }>("SELECT chunk_index FROM upload_chunks WHERE operation_id = ?", change.operationId).toArray();
    this.exec(
      `INSERT INTO upload_sessions (operation_id, device_id, change_json, content_hash, byte_length, chunk_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET created_at = excluded.created_at`,
      change.operationId, authedDeviceId, JSON.stringify(change), change.content.hash, change.content.byteLength, change.content.chunkCount, Date.now(),
    );
    return { uploaded: old.map((r) => r.chunk_index) };
  }

  async uploadChunk(operationId: string, deviceId: string, index: number, data: Uint8Array): Promise<void> {
    if (!OPERATION_ID_RE.test(operationId) || !Number.isSafeInteger(index) || index < 0 || data.byteLength > CHUNK_BYTES) {
      throw new ApiError("BAD_REQUEST", "invalid upload chunk");
    }
    const session = this.uploadSession(operationId);
    if (!session || session.device_id !== deviceId) throw new ApiError("NOT_FOUND", "upload session not found");
    // Chunk uploads outlive a single request; heartbeat so the GC's device
    // liveness check does not prune this device mid-session.
    this.touch(deviceId);
    if (index >= session.chunk_count || (index < session.chunk_count - 1 && data.byteLength !== CHUNK_BYTES)) {
      throw new ApiError("BAD_REQUEST", "invalid chunk size or index");
    }
    const expectedLast = session.byte_length - CHUNK_BYTES * (session.chunk_count - 1);
    if (index === session.chunk_count - 1 && data.byteLength !== expectedLast) throw new ApiError("BAD_REQUEST", "invalid final chunk size");
    this.exec("INSERT OR REPLACE INTO upload_chunks (operation_id, chunk_index, data) VALUES (?, ?, ?)", operationId, index, data);
  }

  async completeUpload(operationId: string, deviceId: string): Promise<{ status: "accepted"; revision: number } | { status: "conflict"; path: string; conflictPath?: string; serverRevision: number }> {
    const session = this.uploadSession(operationId);
    if (!session || session.device_id !== deviceId) throw new ApiError("NOT_FOUND", "upload session not found");
    const change = JSON.parse(session.change_json) as Change;
    const chunks = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM upload_chunks WHERE operation_id = ? ORDER BY chunk_index", operationId).toArray();
    if (chunks.length !== session.chunk_count) throw new ApiError("UPLOAD_INCOMPLETE", "not all file chunks have arrived");
    const bytes = this.joinChunks(chunks.map((r) => new Uint8Array(r.data)), session.byte_length);
    const digest = await this.sha256(bytes);
    if (digest !== session.content_hash) throw new ApiError("HASH_MISMATCH", "uploaded bytes do not match declared SHA-256");
    const result = await this.submitChange(change, deviceId, { strict: true });
    if (result.status === "accepted" || result.status === "conflict") {
      // A conflict copy is also a committed mutation; its receipt points at
      // the copy revision and therefore owns the uploaded bytes.
      const revision = result.status === "accepted" ? result.revision : this.getReceipt(operationId);
      if (revision === null) throw new ApiError("INTERNAL", "missing upload receipt");
      this.ctx.storage.transactionSync(() => {
        // Two devices uploading identical content both dedupe to the same
        // receipt revision; OR IGNORE makes the copy idempotent.
        this.exec(
          "INSERT OR IGNORE INTO change_chunks (revision, chunk_index, data) SELECT ?, chunk_index, data FROM upload_chunks WHERE operation_id = ?",
          revision,
          operationId,
        );
        this.ctx.storage.sql.exec("DELETE FROM upload_chunks WHERE operation_id = ?", operationId);
        this.ctx.storage.sql.exec("DELETE FROM upload_sessions WHERE operation_id = ?", operationId);
      });
    }
    return result;
  }

  async getChangeChunk(revision: number, index: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(index) || index < 0) throw new ApiError("BAD_REQUEST", "invalid chunk request");
    const row = this.ctx.storage.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM change_chunks WHERE revision = ? AND chunk_index = ?", revision, index).toArray()[0];
    if (!row) throw new ApiError("NOT_FOUND", "content chunk not found");
    return new Uint8Array(row.data);
  }

  async alarm(): Promise<void> {
    this.runGarbageCollection();
    await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  async runGarbageCollection(): Promise<void> {
    this.garbageCollect();
  }

  /**
   * Repair operation: wipe server-side sync history for this vault so a device
   * can reseed it as a fresh baseline. Local vault files are never touched.
   */
  async resetVault(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM changes");
      this.ctx.storage.sql.exec("DELETE FROM change_chunks");
      this.ctx.storage.sql.exec("DELETE FROM path_state");
      this.ctx.storage.sql.exec("DELETE FROM operation_receipts");
      this.ctx.storage.sql.exec("DELETE FROM upload_sessions");
      this.ctx.storage.sql.exec("DELETE FROM upload_chunks");
      this.ctx.storage.sql.exec("DELETE FROM devices");
      this.ctx.storage.sql.exec(
        "UPDATE vault_state SET current_revision = 0, min_retained_revision = 1 WHERE id = 1",
      );
    });
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
      const floor = active === null ? -1 : active;
      this.deleteHistoryThrough(floor);
      const expired = this.ctx.storage.sql
        .exec<{ revision: number }>("SELECT revision FROM changes WHERE created_at < ?", now - RETENTION_MS).toArray();
      if (expired.length) this.deleteHistoryThrough(expired[expired.length - 1].revision);
      this.ctx.storage.sql.exec("DELETE FROM upload_chunks WHERE operation_id IN (SELECT operation_id FROM upload_sessions WHERE created_at < ?)", now - UPLOAD_EXPIRY_MS);
      this.ctx.storage.sql.exec("DELETE FROM upload_sessions WHERE created_at < ?", now - UPLOAD_EXPIRY_MS);
      const minRemaining = this.ctx.storage.sql
        .exec<{ min_rev: number | null }>("SELECT MIN(revision) AS min_rev FROM changes")
        .toArray()[0]?.min_rev ?? null;
      const current = this.stateRow().current_revision;
      const minRetained = minRemaining === null ? current + 1 : minRemaining;
      this.ctx.storage.sql.exec(
        "UPDATE vault_state SET min_retained_revision = ? WHERE id = 1",
        minRetained,
      );
      // Tombstones are needed only while a retained change can name them.
      this.ctx.storage.sql.exec("DELETE FROM path_state WHERE deleted = 1 AND last_revision < ?", minRetained);
    });
  }

  private deleteHistoryThrough(revision: number): void {
    // Receipts intentionally survive the revision log they prove: a client
    // mid-retry whose change was pruned must still resolve idempotently.
    this.ctx.storage.sql.exec("DELETE FROM change_chunks WHERE revision <= ?", revision);
    this.ctx.storage.sql.exec("DELETE FROM changes WHERE revision <= ?", revision);
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
          const result = await this.submitChange(msg.change, attached.deviceId!, {
            strict: attached.capabilities?.includes(CHUNK_CAPABILITY) ?? false,
          });
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
    const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : [];
    const attached: Attached = { deviceId: msg.deviceId, accountId: msg.accountId, authed: true, capabilities };
    ws.serializeAttachment(attached);
    this.touch(msg.deviceId);
    this.registerDevice(msg.deviceId, "");
    // A client at revision R needs revisions R+1..: if the retained floor is
    // above R+1, part of that range was already garbage-collected.
    const resyncRequired = msg.lastRevision < state.min_retained_revision - 1;
    if (resyncRequired) {
      this.send(ws, { type: "welcome", serverRevision: state.current_revision, resyncRequired });
      ws.close(4001, "resync required");
      return;
    }
    if (capabilities.includes(CHUNK_CAPABILITY)) {
      await this.catchUp(ws, msg.lastRevision);
    } else {
      // A legacy client cannot fetch chunked bytes; refuse before delivering
      // anything it would corrupt its local state with.
      await this.catchUp(ws, msg.lastRevision, true);
    }
    // Deliver welcome after catch-up so clients can flush local uploads only
    // after the ordered remote baseline has been applied.
    this.send(ws, { type: "welcome", serverRevision: state.current_revision, resyncRequired: false });
  }

  private async catchUp(ws: WebSocket, lastRevision: number, legacy = false): Promise<void> {
    let cursor = lastRevision;
    for (;;) {
      const rows = this.ctx.storage.sql
        .exec<ChangeRow>("SELECT * FROM changes WHERE revision > ? ORDER BY revision LIMIT ?", cursor, CHANGE_BATCH)
        .toArray();
      if (rows.length === 0) return;
      if (legacy && rows.some((r) => r.content_hash !== null)) {
        ws.close(4403, "this vault uses SyncVault v2 content; update the plugin");
        return;
      }
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
    const pathState = this.pathState(path);
    const pathRev = pathState?.last_revision ?? null;
    const allowedStale = (state: PathState | null) => Boolean(
      state && change.causalParents?.includes(state.last_operation_id ?? "") && state.last_revision > change.baseRevision,
    );
    switch (change.operation) {
      case "create":
      case "update": {
        if (pathRev !== null && pathRev > change.baseRevision && !allowedStale(pathState)) {
          return { serverRevision: pathRev, conflictPath: this.freshConflictPath(path, change) };
        }
        const collision = this.collisionPath(path);
        if (collision && collision !== path) return { serverRevision: this.pathRevision(collision) ?? 0, conflictPath: this.freshConflictPath(path, change) };
        return null;
      }
      case "delete": {
        if (pathRev !== null && pathRev > change.baseRevision && !allowedStale(pathState)) {
          return { serverRevision: pathRev };
        }
        return null;
      }
      case "rename": {
        const oldPath = normalizePath(change.oldPath ?? "");
        if (pathRev !== null && pathRev > change.baseRevision && !allowedStale(pathState)) {
          return { serverRevision: pathRev };
        }
        const oldState = this.pathState(oldPath);
        const oldPathRev = oldState?.last_revision ?? null;
        if (oldPathRev !== null && oldPathRev > change.baseRevision && !allowedStale(oldState)) {
          return { serverRevision: oldPathRev };
        }
        const collision = this.collisionPath(path);
        if (collision && collision !== oldPath && collision !== path) return { serverRevision: this.pathRevision(collision) ?? 0 };
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
      this.exec(
        `INSERT INTO changes (revision, operation_id, device_id, operation, path, old_path, base_revision, payload, content_hash, byte_length, chunk_count, causal_parents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        revision,
        change.operationId,
        change.deviceId,
        change.operation,
        path,
        change.oldPath ? normalizePath(change.oldPath) : null,
        change.baseRevision,
        change.payload ?? null,
        change.content?.hash ?? null,
        change.content?.byteLength ?? null,
        change.content?.chunkCount ?? null,
        change.causalParents ? JSON.stringify(change.causalParents) : null,
        Date.now(),
      );
      if (change.operation === "rename") {
        const newPath = normalizePath(change.oldPath!);
        const sourceHash = this.pathState(newPath)?.content_hash ?? undefined;
        this.setPathState(path, revision, false, sourceHash, change.operationId);
        this.setPathState(newPath, revision, true, undefined, change.operationId);
      } else if (change.operation === "delete") {
        this.setPathState(path, revision, true, undefined, change.operationId);
      } else {
        this.setPathState(path, revision, false, change.content?.hash, change.operationId);
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
      // Chunked content must be preserved: completeUpload materialises the
      // uploaded bytes under the copy revision (via the receipt), so the row
      // has to carry the same descriptor for devices to download it.
      content: original.content,
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
    return this.pathState(path)?.last_revision ?? null;
  }

  private pathState(path: string): PathState | null {
    return this.ctx.storage.sql
      .exec<PathState>("SELECT last_revision, deleted, content_hash, last_operation_id FROM path_state WHERE path = ?", path)
      .toArray()[0] ?? null;
  }

  private collisionPath(path: string): string | null {
    const key = pathCollisionKey(path);
    const row = this.ctx.storage.sql
      .exec<{ path: string }>("SELECT path FROM path_state WHERE collision_key = ? AND deleted = 0 LIMIT 1", key)
      .toArray()[0];
    return row?.path ?? null;
  }

  private setPathState(path: string, revision: number, deleted: boolean, contentHash?: string, operationId?: string): void {
    this.exec(
      `INSERT INTO path_state (path, last_revision, deleted, collision_key, content_hash, last_operation_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET last_revision = excluded.last_revision, deleted = excluded.deleted,
         collision_key = excluded.collision_key, content_hash = excluded.content_hash, last_operation_id = excluded.last_operation_id`,
      path,
      revision,
      deleted ? 1 : 0,
      pathCollisionKey(path),
      contentHash ?? null,
      operationId ?? null,
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
      content: row.content_hash === null ? undefined : {
        hash: row.content_hash,
        byteLength: row.byte_length ?? 0,
        chunkCount: row.chunk_count ?? 0,
      },
      causalParents: row.causal_parents ? JSON.parse(row.causal_parents) as string[] : undefined,
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

  private async validateChangeForUpload(change: Change, deviceId: string): Promise<void> {
    // submitChange performs the canonical validation. For an upload session we
    // supply a harmless legacy payload only to pass its transport check; the
    // descriptor is still persisted and verified at completion. Chunked
    // uploads are protocol-v2 only, so the strict retention check applies.
    const probe = { ...change, payload: change.payload ?? "" };
    await this.submitChangeValidation(probe, deviceId, true);
  }

  private async submitChangeValidation(change: Change, deviceId: string, strict: boolean): Promise<void> {
    if (change.deviceId !== deviceId) throw new ApiError("UNAUTHORIZED", "change deviceId does not match authenticated device");
    if (!OPERATION_ID_RE.test(change.operationId ?? "")) throw new ApiError("BAD_REQUEST", "missing operationId");
    const receipt = this.getReceipt(change.operationId);
    if (receipt !== null) return;
    if (!Number.isSafeInteger(change.baseRevision) || change.baseRevision < 0) throw new ApiError("BAD_REQUEST", "invalid baseRevision");
    const state = this.stateRow();
    if (change.baseRevision > state.current_revision) throw new ApiError("BAD_REQUEST", "baseRevision ahead of server");
    if (strict && change.baseRevision < state.min_retained_revision - 1) throw new ApiError("RESYNC_REQUIRED", "local history is older than the retention window");
    try { normalizePath(change.path); if (change.oldPath !== undefined) normalizePath(change.oldPath); } catch (e) { throw new ApiError("BAD_REQUEST", (e as Error).message); }
    if (!isValidContentReference(change.content)) throw new ApiError("BAD_REQUEST", "invalid content descriptor");
  }

  private uploadSession(operationId: string): UploadSession | null {
    return this.ctx.storage.sql.exec<UploadSession>("SELECT * FROM upload_sessions WHERE operation_id = ?", operationId).toArray()[0] ?? null;
  }

  /** Storage writes that can trip the quota surface as a typed API error. */
  private exec(query: string, ...args: SqlStorageValue[]): void {
    try {
      this.ctx.storage.sql.exec(query, ...args);
    } catch (e) {
      if (e instanceof Error && /database or disk is full|SQLITE_FULL|unable to grow/i.test(e.message)) {
        throw new ApiError("INSUFFICIENT_STORAGE", "vault storage is full");
      }
      throw e;
    }
  }

  private joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    if (offset !== length) throw new ApiError("UPLOAD_INCOMPLETE", "uploaded file has the wrong length");
    return output;
  }

  private async sha256(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
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
  content_hash: string | null;
  byte_length: number | null;
  chunk_count: number | null;
  causal_parents: string | null;
  created_at: number;
}

interface PathState extends Record<string, SqlStorageValue> {
  last_revision: number;
  deleted: number;
  content_hash: string | null;
  last_operation_id: string | null;
}

interface UploadSession extends Record<string, SqlStorageValue> {
  operation_id: string;
  device_id: string;
  change_json: string;
  content_hash: string;
  byte_length: number;
  chunk_count: number;
  created_at: number;
}
