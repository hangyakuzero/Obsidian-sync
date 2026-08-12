import { Notice, Plugin, TFile } from "obsidian";
import { SyncVaultSettingsTab } from "./ui/SettingsTab";
import { SyncState } from "./state/SyncState";
import { SyncClient } from "./api/SyncClient";
import { AuthManager } from "./auth/AuthManager";
import { ChangeQueue } from "./sync/ChangeQueue";
import { VaultWatcher, NormalizedEvent } from "./vault/VaultWatcher";
import { ensureParentFolders } from "./vault/ensureParentFolders";
import { SyncEngine, SyncStatus } from "./sync/SyncEngine";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle: "SyncVault: ✓",
  syncing: "SyncVault: ↻ Syncing",
  downloading: "SyncVault: ↓ Downloading",
  uploading: "SyncVault: ↑ Uploading",
  conflict: "SyncVault: ⚠ Conflict",
  offline: "SyncVault: ✕ Offline",
  synced: "SyncVault: ✓ Synced",
  paused: "SyncVault: ⏸ Paused",
};

export default class SyncVaultPlugin extends Plugin {
  state: SyncState = new SyncState({
    load: () => this.loadData(),
    save: (data) => this.saveData(data),
  });
  client = new SyncClient("http://localhost:8787");
  auth: AuthManager = new AuthManager(this.state, this.client);
  queue = new ChangeQueue(this.state);
  watcher = new VaultWatcher({
    readBytes: async (path) => {
      try {
        return await this.app.vault.adapter.readBinary(path);
      } catch {
        return null;
      }
    },
    getBaseRevision: () => this.state.lastRevision,
    onChange: (change) => this.queue.enqueue(change),
    onTooLarge: (path, size) => {
      new Notice(
        `SyncVault: "${path}" (${(size / 1024 / 1024).toFixed(1)} MB) exceeds the 1 MB sync limit and was not synced`,
        8000,
      );
    },
  });
  engine = new SyncEngine(
    this.state,
    this.queue,
    this.watcher,
    {
      write: async (path, data) => {
        await ensureParentFolders(this.app.vault.adapter, path);
        await this.app.vault.adapter.writeBinary(path, data.buffer as ArrayBuffer);
      },
      remove: async (path) => {
        if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
      },
      rename: async (oldPath, newPath) => {
        if (!(await this.app.vault.adapter.exists(oldPath))) {
          if (await this.app.vault.adapter.exists(newPath)) return;
          throw new Error(`rename source does not exist: ${oldPath}`);
        }
        await ensureParentFolders(this.app.vault.adapter, newPath);
        await this.app.vault.adapter.rename(oldPath, newPath);
      },
    },
    (status) => this.setStatusBar(status),
    (message, timeout) => this.notify(message, timeout),
    {
      client: this.client,
      scanner: {
        listFiles: async () => {
          const files = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFile) as TFile[];
          const stats = await Promise.all(
            files.map(async (f) => {
              const stat = await this.app.vault.adapter.stat(f.path).catch(() => null);
              return { path: f.path, size: stat?.size ?? 0 };
            }),
          );
          return stats;
        },
        readBytes: async (path) => {
          return await this.app.vault.adapter.readBinary(path);
        },
      },
    },
  );

  private statusItem: HTMLElement | null = null;
  private lastNoticeAt = new Map<string, number>();

  private notify(message: string, timeout?: number): void {
    const now = Date.now();
    if ((this.lastNoticeAt.get(message) ?? 0) + 5000 > now) return;
    this.lastNoticeAt.set(message, now);
    new Notice(message, timeout ?? 5000);
  }

  async onload(): Promise<void> {
    await this.state.load();
    this.client.setServerUrl(this.state.serverUrl);

    this.statusItem = this.addStatusBarItem();
    this.setStatusBar("idle");

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.engine.syncNow();
      },
    });

    this.addSettingTab(
      new SyncVaultSettingsTab(this.app, this, this.state, this.auth, this.client, this.engine, () => {
        void this.engine.start();
        this.setStatusBar("synced");
      }),
    );

    this.registerVaultEvents();
    void this.engine.start();
  }

  private setStatusBar(status: SyncStatus): void {
    if (this.statusItem) {
      this.statusItem.setText(STATUS_ICONS[status] ?? STATUS_ICONS.idle);
    }
  }

  private registerVaultEvents(): void {
    const vault = this.app.vault;
    const track = (ev: NormalizedEvent) => this.watcher.track(ev);
    this.registerEvent(vault.on("create", (file) => track({ kind: "create", path: file.path })));
    this.registerEvent(vault.on("modify", (file) => track({ kind: "modify", path: file.path })));
    this.registerEvent(vault.on("delete", (file) => track({ kind: "delete", path: file.path })));
    this.registerEvent(vault.on("rename", (file, oldPath) => track({ kind: "rename", path: file.path, oldPath })));
  }

  onunload(): void {
    this.engine.stop();
    this.statusItem?.remove();
  }
}
