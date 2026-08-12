import { isValidBase64, normalizePath, type Change } from "@syncvault/shared";

export interface QueuedChange extends Change {
  attempts: number;
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
};

export class SyncState {
  private data: SyncVaultData;

  constructor(private backend?: SyncStateBackend) {
    this.data = { ...DEFAULT_SYNC_DATA, pendingChanges: [] };
  }

  get connected(): boolean {
    return Boolean(
      this.data.accountId && this.data.vaultId && this.data.deviceId && this.data.deviceToken,
    );
  }

  get serverUrl(): string {
    return this.data.serverUrl;
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

  async load(): Promise<void> {
    const saved = await this.backend?.load();
    if (saved) {
      this.data = { ...DEFAULT_SYNC_DATA, pendingChanges: [], ...saved };
      this.data.lastRevision = this.validRevision(this.data.lastRevision);
      this.data.seeded = this.data.seeded === true;
      this.data.pendingChanges = Array.isArray(this.data.pendingChanges)
        ? this.data.pendingChanges.filter((change) => this.validQueuedChange(change))
        : [];
      this.data.appliedPaths = Array.isArray(this.data.appliedPaths)
        ? this.data.appliedPaths.filter((path) => this.validPath(path))
        : [];
    }
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

  async save(patch: Partial<SyncVaultData>): Promise<void> {
    Object.assign(this.data, patch);
    await this.backend?.save(this.data);
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
    await this.save({
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
    if (
      (item.operation === "create" || item.operation === "update") &&
      (typeof item.payload !== "string" || !isValidBase64(item.payload))
    ) {
      return false;
    }
    return item.operation === "create" ||
      item.operation === "update" ||
      item.operation === "delete" ||
      item.operation === "rename";
  }
}
