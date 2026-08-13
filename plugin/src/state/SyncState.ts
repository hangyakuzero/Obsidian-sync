import { isValidBase64, isValidContentReference, normalizePath, type Change } from "@syncvault/shared";
import type { JournalEntry } from "../storage/Journal";

export interface QueuedChange extends Change {
  attempts: number;
  causalParents?: string[];
  inFlight?: boolean;
  /** Durable staged-file key under the plugin's excluded staging directory. */
  stagedFile?: string;
  /** Server-rejected (4xx) changes are parked, never discarded. */
  blocked?: boolean;
  blockedReason?: string;
}

export interface SyncVaultData {
  serverUrl: string;
  accountId?: string;
  vaultId?: string;
  vaultName?: string;
  deviceId?: string;
  deviceName?: string;
  deviceToken?: string;
  lastRevision: number;
  pendingChanges: QueuedChange[];
  seeded: boolean;
  appliedPaths: string[];
  /** Capped applied-operation journal; authority for "already applied". */
  journal: JournalEntry[];
  /** Mirror appearance.json + installed themes between devices (`syncvault-visual/…`). */
  visualSync: boolean;
}

export interface SyncStateBackend {
  load(): Promise<Partial<SyncVaultData> | undefined>;
  save(data: SyncVaultData): Promise<void>;
}

export const DEFAULT_SYNC_DATA: SyncVaultData = {
  serverUrl: __SYNCVAULT_SERVER_URL__,
  lastRevision: 0,
  pendingChanges: [],
  seeded: false,
  appliedPaths: [],
  journal: [],
  visualSync: true,
};

export class SyncState {
  private data: SyncVaultData;
  private loaded: Promise<void> = Promise.resolve();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private backend?: SyncStateBackend) {
    this.data = { ...DEFAULT_SYNC_DATA, pendingChanges: [], journal: [], appliedPaths: [] };
  }

  get connected(): boolean {
    return Boolean(
      this.data.accountId && this.data.vaultId && this.data.deviceId && this.data.deviceToken,
    );
  }

  get serverUrl(): string {
    return this.data.serverUrl;
  }

  get visualSync(): boolean {
    return this.data.visualSync === true;
  }

  get accountId(): string | undefined {
    return this.data.accountId;
  }

  get vaultId(): string | undefined {
    return this.data.vaultId;
  }

  get vaultName(): string | undefined {
    return this.data.vaultName;
  }

  get deviceId(): string | undefined {
    return this.data.deviceId;
  }

  get deviceName(): string | undefined {
    return this.data.deviceName;
  }

  get deviceToken(): string | undefined {
    return this.data.deviceToken;
  }

  get lastRevision(): number {
    return this.data.lastRevision;
  }

  get pendingChanges(): QueuedChange[] {
    return this.data.pendingChanges;
  }

  get journal(): JournalEntry[] {
    return this.data.journal;
  }

  async load(): Promise<void> {
    this.loaded = (async () => {
      const saved = await this.backend?.load();
      if (saved) {
        this.data = {
          ...DEFAULT_SYNC_DATA,
          pendingChanges: [],
          journal: [],
          appliedPaths: [],
          ...saved,
        };
        this.data.lastRevision = this.validRevision(this.data.lastRevision);
        this.data.seeded = this.data.seeded === true;
        this.data.pendingChanges = Array.isArray(this.data.pendingChanges)
          ? this.data.pendingChanges.filter((change) => this.validQueuedChange(change))
          : [];
        this.data.appliedPaths = Array.isArray(this.data.appliedPaths)
          ? this.data.appliedPaths.filter((path) => this.validPath(path))
          : [];
        this.data.journal = Array.isArray(this.data.journal)
          ? this.data.journal.filter((e) => this.validJournalEntry(e)).slice(-500)
          : [];
      }
    })();
    await this.loaded;
  }

  get seeded(): boolean {
    return this.data.seeded;
  }

  async markSeeded(): Promise<void> {
    if (!this.data.seeded) {
      await this.save({ seeded: true });
    }
  }

  hasApplied(path: string): boolean {
    return this.data.appliedPaths.includes(path);
  }

  async markApplied(newPath?: string, oldPath?: string): Promise<void> {
    const changed: string[] = [];
    if (newPath && !this.data.appliedPaths.includes(newPath)) {
      this.data.appliedPaths.push(newPath);
      changed.push(newPath);
    }
    if (oldPath) {
      const idx = this.data.appliedPaths.indexOf(oldPath);
      if (idx >= 0) {
        this.data.appliedPaths.splice(idx, 1);
        changed.push(oldPath);
      }
    }
    if (changed.length > 0) {
      await this.save({});
    }
  }

  /**
   * Mutations apply synchronously (so callers never see stale state) but the
   * backend write is serialized: concurrent queue writes, cursor updates,
   * seeded markers, journal updates, and recovery changes cannot overwrite one
   * another, and the latest snapshot always lands last.
   */
  async save(patch: Partial<SyncVaultData>): Promise<void> {
    if (typeof patch.lastRevision === "number") {
      // Cursor writes are monotonic even under concurrency.
      Object.assign(this.data, { ...patch, lastRevision: Math.max(this.data.lastRevision, patch.lastRevision) });
    } else {
      Object.assign(this.data, patch);
    }
    const snapshot = { ...this.data };
    const write = this.writeQueue.then(() => this.backend?.save(snapshot));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  /**
   * Deliberate local resets (disconnect, rebuild, join, recovery) regress the
   * cursor and clear sync state on purpose; the monotonic guard must not fight
   * them. Identity fields passed in `patch` are kept.
   */
  async resetSyncState(patch: Partial<SyncVaultData>): Promise<void> {
    Object.assign(this.data, patch);
    const snapshot = { ...this.data };
    const write = this.writeQueue.then(() => this.backend?.save(snapshot));
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  async setServerUrl(url: string): Promise<void> {
    await this.save({ serverUrl: url });
  }

  async setLastRevision(revision: number): Promise<void> {
    if (revision > this.data.lastRevision) {
      await this.save({ lastRevision: revision });
    }
  }

  async disconnect(): Promise<void> {
    await this.resetSyncState({
      accountId: undefined,
      vaultId: undefined,
      vaultName: undefined,
      deviceId: undefined,
      deviceName: undefined,
      deviceToken: undefined,
      lastRevision: 0,
      pendingChanges: [],
      seeded: false,
      appliedPaths: [],
      journal: [],
    });
  }

  private validRevision(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }

  private validPath(path: unknown): path is string {
    if (typeof path !== "string") return false;
    try {
      normalizePath(path);
      return true;
    } catch {
      return false;
    }
  }

  private validJournalEntry(entry: unknown): entry is JournalEntry {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Partial<JournalEntry>;
    if (
      typeof e.operationId !== "string" ||
      e.operationId.length === 0 ||
      typeof e.revision !== "number" ||
      !Number.isSafeInteger(e.revision) ||
      e.revision < 0 ||
      !Array.isArray(e.paths) ||
      e.paths.length === 0 ||
      !e.paths.every((p) => this.validPath(p))
    ) {
      return false;
    }
    return true;
  }

  private validQueuedChange(change: unknown): change is QueuedChange {
    if (!change || typeof change !== "object") return false;
    const item = change as Partial<QueuedChange>;
    if (
      typeof item.operationId !== "string" ||
      typeof item.revision !== "number" ||
      typeof item.deviceId !== "string" ||
      typeof item.operation !== "string" ||
      typeof item.baseRevision !== "number" ||
      typeof item.timestamp !== "number" ||
      typeof item.attempts !== "number" ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 0 ||
      !Number.isSafeInteger(item.baseRevision) ||
      item.baseRevision < 0 ||
      !Number.isSafeInteger(item.attempts) ||
      item.attempts < 0 ||
      !this.validPath(item.path)
    ) {
      return false;
    }
    if (item.oldPath !== undefined && !this.validPath(item.oldPath)) return false;
    if (item.causalParents !== undefined) {
      if (
        !Array.isArray(item.causalParents) ||
        item.causalParents.some((p) => typeof p !== "string")
      ) {
        return false;
      }
    }
    if (item.inFlight !== undefined && typeof item.inFlight !== "boolean") return false;
    if (item.blocked !== undefined && typeof item.blocked !== "boolean") return false;
    if (item.blockedReason !== undefined && typeof item.blockedReason !== "string") return false;
    if (item.stagedFile !== undefined) {
      // Staging keys are bare filenames (hex operation ids); reject traversal.
      if (
        typeof item.stagedFile !== "string" ||
        item.stagedFile.length === 0 ||
        item.stagedFile.includes("/") ||
        item.stagedFile === "." ||
        item.stagedFile === ".."
      ) {
        return false;
      }
    }
    if (item.operation === "create" || item.operation === "update") {
      const hasPayload = typeof item.payload === "string" && isValidBase64(item.payload);
      const hasContent =
        item.content !== undefined && isValidContentReference(item.content);
      if (!hasPayload && !hasContent) return false;
    }
    return item.operation === "create" ||
      item.operation === "update" ||
      item.operation === "delete" ||
      item.operation === "rename";
  }
}
