import { Notice, Plugin } from "obsidian";
import { SyncVaultSettingsTab } from "./ui/SettingsTab";
import { SyncState } from "./state/SyncState";
import { SyncClient } from "./api/SyncClient";
import { AuthManager } from "./auth/AuthManager";
import { ChangeQueue } from "./sync/ChangeQueue";
import { VaultWatcher, NormalizedEvent } from "./vault/VaultWatcher";
import { SyncEngine, SyncStatus } from "./sync/SyncEngine";

const STATUS_ICONS: Record<SyncStatus, string> = {
  idle: "SyncVault: ✓",
  syncing: "SyncVault: ↻ Syncing",
  downloading: "SyncVault: ↓ Downloading",
  uploading: "SyncVault: ↑ Uploading",
  conflict: "SyncVault: ⚠ Conflict",
  offline: "SyncVault: ✕ Offline",
  synced: "SyncVault: ✓ Synced",
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
      write: (path, data) => this.app.vault.adapter.writeBinary(path, data.buffer as ArrayBuffer),
      remove: (path) => this.app.vault.adapter.remove(path),
      rename: (oldPath, newPath) => this.app.vault.adapter.rename(oldPath, newPath),
    },
    (status) => this.setStatusBar(status),
    (message, timeout) => new Notice(message, timeout ?? 5000),
  );

  private statusItem: HTMLElement | null = null;

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
        this.engine.start();
        this.setStatusBar("synced");
      }),
    );

    this.registerVaultEvents();
    this.engine.start();
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