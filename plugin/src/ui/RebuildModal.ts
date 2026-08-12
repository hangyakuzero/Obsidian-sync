import { App, Modal, Notice, Setting } from "obsidian";
import { SyncClient, ApiError } from "../api/SyncClient";
import { SyncState } from "../state/SyncState";
import { friendlyApiMessage } from "./friendlyErrors";

export interface RebuildContext {
  accountId?: string;
  vaultId?: string;
  vaultName?: string;
  deviceId?: string;
  deviceToken?: string;
}

export class RebuildModal extends Modal {
  private password = "";

  constructor(
    app: App,
    private state: SyncState,
    private client: SyncClient,
    private mode: "rebuild" | "join",
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const rebuild = this.mode === "rebuild";
    contentEl.createEl("h2", { text: rebuild ? "Rebuild vault from this device" : "Join rebuilt vault" });
    contentEl.createEl("p", {
      text: rebuild
        ? "This device's files become the new vault baseline. The server's sync history for this vault is wiped (nothing on any device is deleted), then every local file is uploaded with its real content."
        : "This device downloads the rebuilt vault contents from the server. Local files on this device are not deleted, but files present in the rebuilt vault will overwrite local copies.",
    });
    contentEl.createEl("p", {
      text: `Vault: ${this.state.vaultName ?? this.state.vaultId ?? "?"}`,
    });

    if (rebuild) {
      new Setting(contentEl).setName("Account password").addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("required — confirms you own this account");
        t.onChange((v) => (this.password = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void this.submit();
        });
      });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(rebuild ? "Rebuild (wipes server history)" : "Join rebuilt vault")
          .setWarning()
          .onClick(() => void this.submit()),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  private async submit(): Promise<void> {
    const rebuild = this.mode === "rebuild";
    const ctx: RebuildContext = {
      accountId: this.state.accountId,
      vaultId: this.state.vaultId,
      vaultName: this.state.vaultName,
      deviceId: this.state.deviceId,
      deviceToken: this.state.deviceToken,
    };
    if (!ctx.accountId || !ctx.vaultId || !ctx.deviceId || !ctx.deviceToken) {
      new Notice("SyncVault: not linked; reconnect first", 6000);
      return;
    }
    try {
      if (rebuild) {
        if (!this.password) {
          new Notice("SyncVault: account password required", 5000);
          return;
        }
        const confirm = ctx.vaultName ?? ctx.vaultId;
        await this.client.resetVault(
          ctx.accountId,
          ctx.vaultId,
          ctx.deviceId,
          ctx.deviceToken,
          this.password,
          confirm,
        );
        // Reset local cursor and seed state; keep identity so the device can
        // immediately reseed this vault from its own files.
        await this.state.save({
          lastRevision: 0,
          seeded: false,
          appliedPaths: [],
          pendingChanges: [],
        });
        new Notice("SyncVault: server history wiped — uploading files...", 6000);
      } else {
        // Join a rebuilt vault: download the new baseline but do NOT seed this
        // device's local files over it.
        await this.state.save({
          lastRevision: 0,
          seeded: true,
          appliedPaths: [],
          pendingChanges: [],
        });
        new Notice("SyncVault: joining rebuilt vault — downloading...", 6000);
      }
      this.close();
      this.onDone();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      new Notice(`SyncVault: ${friendlyApiMessage(code, (e as Error).message)}`, 6000);
    }
  }
}
