import { App, Modal, Notice, Setting } from "obsidian";
import { AuthManager } from "../auth/AuthManager";
import { ApiError } from "../api/SyncClient";
import { friendlyApiMessage } from "./friendlyErrors";

export class ReconnectModal extends Modal {
  private password = "";

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
    contentEl.addClass("syncvault-modal");
    contentEl.createEl("h2", { text: "Reconnect vault" });
    contentEl.createEl("p", {
      text: "Rotates this device's sync token so syncing can resume. Your files, pending changes and sync history are kept.",
    });
    contentEl.createEl("p", { text: `Account: ${this.auth.accountId}` });

    new Setting(contentEl).setName("Account password").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("required — confirms you own this account");
      t.onChange((v) => (this.password = v));
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this.submit();
      });
    });

    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Reconnect").setCta().onClick(() => void this.submit()),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  private async submit(): Promise<void> {
    if (!this.password) {
      new Notice("SyncVault: enter your account password");
      return;
    }
    try {
      await this.auth.reconnect(this.password);
      this.close();
      new Notice("SyncVault: reconnected — resuming sync");
      this.onDone();
    } catch (e) {
      const err = e as ApiError;
      new Notice(`SyncVault: ${friendlyApiMessage(err.code, err.message)}`, 6000);
    }
  }
}
