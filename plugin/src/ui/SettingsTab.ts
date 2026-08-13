import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SyncVaultPlugin from "../main";
import { SyncState } from "../state/SyncState";
import { AuthManager } from "../auth/AuthManager";
import { WelcomeModal } from "./WelcomeModal";
import { RecoverModal } from "./RecoverModal";
import { ReconnectModal } from "./ReconnectModal";
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
  paused: "⏸ Paused",
};

export class SyncVaultSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: SyncVaultPlugin,
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
    containerEl.addClass("syncvault-settings");
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

    if (this.engine.isPaused) {
      new Setting(containerEl)
        .setName("Sync paused")
        .setDesc("A remote change could not be applied, so polling stopped.")
        .addButton((b) =>
          b.setButtonText("Resume sync").setCta().onClick(() => {
            void this.engine.resume().then(() => this.display());
          }),
        );
    }

    // Visual appearance mirror: appearance.json + installed themes. Applied
    // appearances are written to the vault config dir and take effect on the
    // next Obsidian restart (passive — we never hot-swap the UI).
    const visualEnabled = this.state.visualSync;
    new Setting(containerEl)
      .setName("Sync visual appearance")
      .setDesc(
        "Mirrors appearance.json and installed themes between devices. " +
          (this.plugin.lastVisualApplyAt > 0
            ? "Changes will apply after Obsidian restarts."
            : "Applied appearances take effect after Obsidian restarts."),
      )
      .addToggle((t) =>
        t
          .setValue(visualEnabled)
          .setTooltip("Mirror themes and selected appearance between devices")
          .onChange((v) => {
            void this.state.save({ visualSync: v }).then(() => this.display());
          }),
      )
      .addButton((b) =>
        b.setButtonText("Sync visual files now").onClick(() => {
          this.plugin.syncVisualNow();
          new Notice("SyncVault: visual files queued for sync");
        }),
      );

    new Setting(containerEl)
      .setName("Recover sync — reset baseline")
      .setDesc("Last resort when the server history is unusable (e.g. old builds uploaded files without content). This device becomes the new baseline and re-uploads all its files.")
      .addButton((b) =>
        b
          .setButtonText("Reset baseline from this device")
          .setWarning()
          .onClick(() => {
            new RecoverModal(
              this.app,
              this.state,
              this.client,
              "reset",
              () => {
                void this.engine.resume();
                this.display();
              },
              () => this.engine.resetForRebuild(),
              () => this.engine.enterJoinMode(),
              () => this.engine.countSyncableFiles(),
            ).open();
          }),
      );

    new Setting(containerEl)
      .setName("Recover sync — join rebuilt baseline")
      .setDesc("Download the rebuilt baseline to this device. Local files that differ are kept as conflict copies, not deleted.")
      .addButton((b) =>
        b
          .setButtonText("Pull rebuilt baseline")
          .setWarning()
          .onClick(() => {
            new RecoverModal(
              this.app,
              this.state,
              this.client,
              "join",
              () => {
                void this.engine.resume();
                this.display();
              },
              () => this.engine.resetForRebuild(),
              () => this.engine.enterJoinMode(),
              () => this.engine.countSyncableFiles(),
            ).open();
          }),
      );

    new Setting(containerEl)
      .setName("Reconnect vault")
      .setDesc("Rotate this device's sync token after authentication problems. Files, pending changes and sync state are kept.")
      .addButton((b) =>
        b.setButtonText("Reconnect").setCta().onClick(() => {
          new ReconnectModal(this.app, this.auth, () => {
            this.engine.authRecovered();
            this.display();
          }).open();
        }),
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Disconnect vault").onClick(async () => {
        this.engine.stop();
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
