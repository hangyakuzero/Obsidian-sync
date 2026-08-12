import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SyncVaultPlugin from "../main";
import { SyncState } from "../state/SyncState";
import { AuthManager } from "../auth/AuthManager";
import { WelcomeModal } from "./WelcomeModal";
import { SyncClient } from "../api/SyncClient";
import type { SyncEngine, SyncStatus } from "../sync/SyncEngine";

const STATUS_LABELS: Record<SyncStatus, string> = {
  idle: "idle",
  syncing: "↻ Syncing",
  downloading: "↓ Downloading",
  uploading: "↑ Uploading",
  conflict: "⚠ Conflict",
  offline: "✕ Offline",
  synced: "✓ Synced",
};

export class SyncVaultSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: SyncVaultPlugin,
    private state: SyncState,
    private auth: AuthManager,
    private client: SyncClient,
    private engine: SyncEngine,
    private afterSetup?: () => void,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "SyncVault" });

    new Setting(containerEl).setName("Server URL").addText((t) => {
      t.setValue(this.state.serverUrl);
      t.setPlaceholder("https://sync.example.com");
      t.onChange(async (v) => {
        const url = v.trim();
        await this.state.setServerUrl(url);
        this.client.setServerUrl(url);
      });
    });

    if (!this.state.connected) {
      this.renderWelcome(containerEl);
      return;
    }

    new Setting(containerEl).setName("Account").setDesc(this.state.accountId ?? "");
    new Setting(containerEl).setName("Vault").setDesc(this.state.vaultName ?? this.state.vaultId ?? "");
    new Setting(containerEl).setName("Device").setDesc(this.state.deviceName ?? this.state.deviceId ?? "");
    new Setting(containerEl)
      .setName("Status")
      .setDesc(
        `${STATUS_LABELS[this.engine.status]} · revision ${this.state.lastRevision} · ${this.engine.pendingCount} pending`,
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Sync now").setCta().onClick(() => {
        void this.engine.syncNow().then(() => this.display());
      }),
    );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Disconnect vault").onClick(async () => {
        await this.state.disconnect();
        new Notice("SyncVault: vault disconnected");
        this.display();
      }),
    );
  }

  private renderWelcome(parent: HTMLElement): void {
    parent.createEl("p", { text: "Welcome to SyncVault. Link this vault to sync it between your devices." });
    new Setting(parent).addButton((b) =>
      b.setButtonText("Set up SyncVault").setCta().onClick(() => {
        new WelcomeModal(this.app, this.auth, () => {
          this.display();
          this.afterSetup?.();
        }).open();
      }),
    );
  }
}