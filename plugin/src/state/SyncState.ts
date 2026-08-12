import type { Change } from "@syncvault/shared";

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
      if (!Array.isArray(this.data.pendingChanges)) this.data.pendingChanges = [];
      if (!Array.isArray(this.data.appliedPaths)) this.data.appliedPaths = [];
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
      seeded: false,
      appliedPaths: [],
    });
  }
}