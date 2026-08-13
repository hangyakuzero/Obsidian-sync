import { Notice, Plugin, TFile } from "obsidian";
import type { Change } from "@syncvault/shared";
import { SyncVaultSettingsTab } from "./ui/SettingsTab";
import { SyncState } from "./state/SyncState";
import { SyncClient } from "./api/SyncClient";
import { AuthManager } from "./auth/AuthManager";
import { ChangeQueue } from "./sync/ChangeQueue";
import { VaultWatcher, NormalizedEvent } from "./vault/VaultWatcher";
import { ensureParentFolders } from "./vault/ensureParentFolders";
import { VaultStaging } from "./storage/Staging";
import { VisualSync, VisualChange } from "./visual/VisualSync";
import { SyncEngine, SyncStatus } from "./sync/SyncEngine";

// Durable staging dir under the plugin's config directory; `.obsidian` is
// excluded from sync, so snapshots never reach the server.
const STAGING_DIR = "plugins/syncvault/staging";

/** Config-filtered files live under the vault config dir (usually `.obsidian`). */
function configRel(path: string): string | null {
  if (path === ".obsidian") return "";
  if (path.startsWith(".obsidian/")) return path.slice(".obsidian/".length);
  return null;
}

/** Resolve a config-relative path to an adapter-path under `configDir`. */
function configResolve(configDir: string, rel: string): string {
  return rel === "" ? configDir : `${configDir}/${rel}`;
}

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
  client = new SyncClient(__SYNCVAULT_SERVER_URL__);
  auth: AuthManager = new AuthManager(this.state, this.client);
  queue = new ChangeQueue(this.state);
  staging = new VaultStaging(
    {
      exists: (path) => this.app.vault.adapter.exists(path),
      mkdir: (path) => this.app.vault.adapter.mkdir(path),
      writeBinary: (path, data) => this.app.vault.adapter.writeBinary(path, data),
      readBinary: (path) => this.app.vault.adapter.readBinary(path),
      remove: (path) => this.app.vault.adapter.remove(path),
      list: async (folder) => {
        const listing = await this.app.vault.adapter.list(folder);
        // Obsidian's ListedFiles.files may be bare names or full paths
        // depending on the adapter; normalize to bare names.
        const entries = Array.isArray(listing.files) ? listing.files : [];
        return entries.map((entry) => {
          const name = typeof entry === "string" ? entry : (entry as { name?: string }).name ?? String(entry);
          return name.startsWith(folder) ? name.slice(folder.length + 1) : name;
        });
      },
    },
    `${this.app.vault.configDir}/${STAGING_DIR}`,
  );
  watcher: VaultWatcher = new VaultWatcher({
    readBytes: async (path) => {
      const vr = VisualSync.relPath(path);
      const real = vr !== null ? configResolve(this.app.vault.configDir, vr) : path;
      // A missing file is a deletion (null). A failed read of an existing
      // file throws so the watcher can retry instead of dropping the capture.
      const st = await this.app.vault.adapter.stat(real).catch(() => null);
      if (st === null) return null;
      if (st.type === "folder") return null;
      return await this.app.vault.adapter.readBinary(real);
    },
    getBaseRevision: () => this.state.lastRevision,
    stage: (operationId, bytes) => this.staging.save(operationId, bytes),
    onChange: (change: Change) => this.engine.enqueueLocal(change),
    onTooLarge: (path, size) => {
      new Notice(
        `SyncVault: "${path}" (${(size / 1024 / 1024).toFixed(1)} MB) exceeds the 16 MB sync limit and was not synced`,
        8000,
      );
    },
  });
  /** Mirrors `.obsidian/appearance.json` + installed themes via the
   * `syncvault-visual/…` logical namespace (same change stream, no new
   * protocol). */
  visual: VisualSync = new VisualSync(
    {
      stat: async (rel) => {
        const st = await this.app.vault.adapter
          .stat(configResolve(this.app.vault.configDir, rel))
          .catch(() => null);
        return st ? { kind: st.type === "folder" ? "folder" : "file", size: st.size ?? 0 } : null;
      },
      readBytes: async (rel) => {
        try {
          return new Uint8Array(await this.app.vault.adapter.readBinary(configResolve(this.app.vault.configDir, rel)));
        } catch {
          return null;
        }
      },
      list: async (rel) => {
        const listing = await this.app.vault.adapter
          .list(configResolve(this.app.vault.configDir, rel))
          .catch(() => null);
        if (!listing) return [];
        const entries = Array.isArray(listing.files) ? listing.files : [];
        return entries.map((entry) => {
          const name = typeof entry === "string" ? entry : (entry as { name?: string }).name ?? String(entry);
          return name.startsWith(rel) ? name.slice(rel.length + 1) : name;
        });
      },
    },
    (change: VisualChange) => {
      void this.engine.enqueueVisualChange(change.logicalPath, change.bytes as Uint8Array<ArrayBuffer>);
    },
    (path, size) => {
      new Notice(
        `SyncVault: "${path}" (${(size / 1024 / 1024).toFixed(1)} MB) exceeds the 16 MB sync limit and was not synced`,
        8000,
      );
    },
  );
  engine: SyncEngine = new SyncEngine(
    this.state,
    this.queue,
    this.watcher,
    {
      write: async (path, data) => {
        const vr = VisualSync.relPath(path);
        if (vr !== null) {
          // Disabled → advance the cursor without writing (config changes are
          // not applied to this device).
          if (this.state.visualSync) {
            const target = configResolve(this.app.vault.configDir, vr);
            await ensureParentFolders(this.app.vault.adapter, target);
            const buffer = data.buffer.slice(
              data.byteOffset,
              data.byteOffset + data.byteLength,
            ) as ArrayBuffer;
            await this.app.vault.adapter.writeBinary(target, buffer);
            this.lastVisualApplyAt = Date.now();
          }
          return;
        }
        await ensureParentFolders(this.app.vault.adapter, path);
        const buffer = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer;
        await this.app.vault.adapter.writeBinary(path, buffer);
      },
      readFile: async (path) => {
        const vr = VisualSync.relPath(path);
        const real = vr !== null
          ? (this.state.visualSync ? configResolve(this.app.vault.configDir, vr) : null)
          : path;
        if (real === null) return null;
        try {
          return new Uint8Array(await this.app.vault.adapter.readBinary(real));
        } catch {
          return null;
        }
      },
      stat: async (path) => {
        const vr = VisualSync.relPath(path);
        const real = vr !== null
          ? (this.state.visualSync ? configResolve(this.app.vault.configDir, vr) : null)
          : path;
        if (real === null) return null;
        const stat = await this.app.vault.adapter.stat(real).catch(() => null);
        return stat?.type === "folder" ? "folder" : stat?.type === "file" ? "file" : null;
      },
      remove: async (path) => {
        const vr = VisualSync.relPath(path);
        if (vr !== null) {
          if (!this.state.visualSync) return;
          const target = configResolve(this.app.vault.configDir, vr);
          if (await this.app.vault.adapter.exists(target)) {
            await this.app.vault.adapter.remove(target);
          }
          return;
        }
        if (await this.app.vault.adapter.exists(path)) {
          await this.app.vault.adapter.remove(path);
        }
      },
      rename: async (oldPath, newPath) => {
        const oldVr = VisualSync.relPath(oldPath);
        if (oldVr !== null) {
          if (!this.state.visualSync) return;
          const from = configResolve(this.app.vault.configDir, oldVr);
          const to = configResolve(this.app.vault.configDir, VisualSync.relPath(newPath) ?? newPath);
          if (!(await this.app.vault.adapter.exists(from))) return;
          await ensureParentFolders(this.app.vault.adapter, to);
          await this.app.vault.adapter.rename(from, to);
          return;
        }
        if (!(await this.app.vault.adapter.exists(oldPath))) return;
        await ensureParentFolders(this.app.vault.adapter, newPath);
        // Occupied destinations, case-only renames, and conflict copies are
        // handled by the engine before this point.
        await this.app.vault.adapter.rename(oldPath, newPath);
      },
    },
    (status) => this.setStatusBar(status),
    (message, timeout) => this.notify(message, timeout),
    {
      client: this.client,
      staging: this.staging,
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
  private visualTimer: number | null = null;
  /** Set when a remote visual appearance change was applied to this device. */
  lastVisualApplyAt = 0;

  /** Manual trigger for the visual-appearance mirror. */
  syncVisualNow(): void {
    if (this.state.visualSync) void this.visual.scan();
  }

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

    // Visual appearance mirror: startup scan, then low-frequency refresh so
    // changes made while the plugin was off or disabled still converge.
    this.syncVisualNow();
    this.visualTimer = window.setInterval(() => this.syncVisualNow(), 30 * 60 * 1000);
  }

  private setStatusBar(status: SyncStatus): void {
    if (this.statusItem) {
      this.statusItem.setText(STATUS_ICONS[status] ?? STATUS_ICONS.idle);
    }
  }

  private registerVaultEvents(): void {
    const vault = this.app.vault;
    const track = (ev: NormalizedEvent) => this.watcher.track(ev);
    const handle = (kind: NormalizedEvent["kind"], path: string, oldPath?: string): void => {
      // Config-dir events (appearance.json, themes) → logical `syncvault-visual/…`.
      const rel = configRel(path);
      if (rel !== null) {
        if (!this.state.visualSync) return;
        const logical = this.visual.translate(rel);
        if (!logical) return;
        if (oldPath !== undefined) {
          const oldRel = configRel(oldPath);
          if (oldRel === null) return;
          const oldLogical = this.visual.translate(oldRel);
          if (oldLogical === null) return;
          track({ kind, path: logical, oldPath: oldLogical } as NormalizedEvent);
          return;
        }
        track({ kind, path: logical } as NormalizedEvent);
        return;
      }
      track({ kind, path, oldPath: oldPath as string | undefined } as NormalizedEvent);
    };
    // Only TFile events are syncable; folders and abstract files are ignored.
    this.registerEvent(vault.on("create", (file) => {
      if (file instanceof TFile) handle("create", file.path);
    }));
    this.registerEvent(vault.on("modify", (file) => {
      if (file instanceof TFile) handle("modify", file.path);
    }));
    this.registerEvent(vault.on("delete", (file) => {
      if (file instanceof TFile) handle("delete", file.path);
    }));
    this.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) handle("rename", file.path, oldPath);
    }));
  }

  onunload(): void {
    if (this.visualTimer !== null) {
      window.clearInterval(this.visualTimer);
      this.visualTimer = null;
    }
    this.engine.stop();
    this.statusItem?.remove();
  }
}
