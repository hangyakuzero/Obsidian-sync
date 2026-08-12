import { App, Modal, Notice, Setting } from "obsidian";
import { AuthManager } from "../auth/AuthManager";
import { ApiError } from "../api/SyncClient";
import { friendlyApiMessage } from "./friendlyErrors";

export class WelcomeModal extends Modal {
  constructor(
    app: App,
    private auth: AuthManager,
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Welcome to SyncVault" });
    contentEl.createEl("p", { text: "Synchronize this vault between your devices." });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("New user").setCta().onClick(() => {
          this.close();
          new NewUserModal(this.app, this.auth, this.onDone).open();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Existing user").onClick(() => {
          this.close();
          new ExistingUserModal(this.app, this.auth, this.onDone).open();
        }),
      );
  }
}

class NewUserModal extends Modal {
  private accountId: string;
  private password = "";
  private vaultName = "";
  private deviceName = "";

  constructor(app: App, private auth: AuthManager, private onDone: () => void) {
    super(app);
    this.accountId = AuthManager.suggestAccountId();
    this.deviceName = this.platformName();
  }

  private platformName(): string {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
    return "Desktop";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create account" });
    if (this.deviceName === "Desktop") {
      this.deviceName = "Desktop";
    }

    new Setting(contentEl).setName("Account ID").addText((t) => {
      t.setValue(this.accountId);
      t.onChange((v) => (this.accountId = v.trim()));
    });
    new Setting(contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.password = v));
    });
    new Setting(contentEl).setName("Vault name").addText((t) => {
      t.setValue("My Notes");
      t.onChange((v) => (this.vaultName = v.trim()));
    });
    new Setting(contentEl).setName("Device name").addText((t) => {
      t.setValue(this.deviceName);
      t.onChange((v) => (this.deviceName = v.trim()));
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Create").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          await this.auth.newUser({
            accountId: this.accountId,
            password: this.password,
            vaultName: this.vaultName || "My Notes",
            deviceName: this.deviceName,
          });
          new Notice("SyncVault: account and vault created");
          this.close();
          this.onDone();
        } catch (e) {
          new Notice(`SyncVault: ${friendlyApiMessage(e instanceof ApiError ? e.code : undefined, (e as Error).message)}`, 6000);
          b.setDisabled(false);
        }
      }),
    );
  }
}

class ExistingUserModal extends Modal {
  private accountId = "";
  private password = "";
  private deviceName = "";
  private vaults: { vaultId: string; name: string }[] = [];
  private selectedVaultId = "";

  constructor(app: App, private auth: AuthManager, private onDone: () => void) {
    super(app);
    const ua = navigator.userAgent;
    this.deviceName = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : "Desktop";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sign in" });

    new Setting(contentEl).setName("Account ID").addText((t) => {
      t.setPlaceholder("user1234");
      t.onChange((v) => (this.accountId = v.trim()));
    });
    new Setting(contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => (this.password = v));
    });
    new Setting(contentEl).setName("Device name").addText((t) => {
      t.setValue(this.deviceName);
      t.onChange((v) => (this.deviceName = v.trim()));
    });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Sign in").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          this.vaults = await this.auth.fetchVaults(this.accountId, this.password);
        } catch (e) {
          new Notice(`SyncVault: ${friendlyApiMessage(e instanceof ApiError ? e.code : undefined, (e as Error).message)}`, 6000);
          b.setDisabled(false);
          return;
        }
        if (this.vaults.length === 0) {
          new Notice("SyncVault: no vaults found", 6000);
          b.setDisabled(false);
          return;
        }
        this.renderVaultPicker();
        this.selectedVaultId = this.vaults[0].vaultId;
        b.setDisabled(false);
      }),
    );
  }

  private renderVaultPicker(): void {
    const { contentEl } = this;
    const setting = new Setting(contentEl).setName("Vault to sync");
    setting.addDropdown((d) => {
      for (const v of this.vaults) d.addOption(v.vaultId, v.name);
      d.onChange((v) => (this.selectedVaultId = v));
    });
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Link this vault").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          const vault = this.vaults.find((v) => v.vaultId === this.selectedVaultId);
          await this.auth.existingUser({
            accountId: this.accountId,
            password: this.password,
            vaultId: this.selectedVaultId,
            vaultName: vault ? vault.name : "",
            deviceName: this.deviceName,
          });
          new Notice("SyncVault: vault linked");
          this.close();
          this.onDone();
        } catch (e) {
          new Notice(`SyncVault: ${friendlyApiMessage(e instanceof ApiError ? e.code : undefined, (e as Error).message)}`, 6000);
          b.setDisabled(false);
        }
      }),
    );
  }
}