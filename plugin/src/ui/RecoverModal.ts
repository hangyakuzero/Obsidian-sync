import { App, Modal, Notice, Setting } from "obsidian";
import { SyncClient, ApiError } from "../api/SyncClient";
import { SyncState } from "../state/SyncState";
import { friendlyApiMessage } from "./friendlyErrors";

export interface RecoverContext {
  accountId?: string;
  vaultId?: string;
  vaultName?: string;
  deviceId?: string;
  deviceToken?: string;
}

/**
 * Guided "Recover sync" flow, replacing the old Rebuild/Join modals.
 *
 * - Reset baseline from this device: wipes server history after a local safety
 *   check (this device must actually hold syncable files to seed).
 * - Pull the rebuilt baseline: downloads the rebuilt baseline without seeding
 *   this device's files over it. Local files that differ are overwritten by
 *   the baseline (server-revision last-write-wins); existing files whose names
 *   contain `conflict-` are left untouched.
 */
export class RecoverModal extends Modal {
  private password = "";

  constructor(
    app: App,
    private state: SyncState,
    private client: SyncClient,
    private mode: "reset" | "join",
    private onDone: () => void,
    private beforeReset: () => Promise<void>,
    private countSyncable: () => Promise<number>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncvault-modal");
    const reset = this.mode === "reset";
    contentEl.createEl("h2", { text: "Recover sync" });
    contentEl.createEl("p", {
      text: reset
        ? "Your vault's sync history is corrupted or unusable. This device becomes the new baseline: the server's sync history for this vault is wiped (nothing on any device is deleted), then every local file below is uploaded with its real content."
        : "This device downloads the rebuilt baseline from the server. Local files that differ from the baseline are overwritten by it; nothing is preserved as a conflict copy.",
    });
    contentEl.createEl("p", { text: `Vault: ${this.state.vaultName ?? this.state.vaultId ?? "?"}` });

    if (reset) {
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
          .setButtonText(reset ? "Reset baseline from this device" : "Pull rebuilt baseline")
          .setWarning()
          .onClick(() => void this.submit()),
      )
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => this.close()),
      );
  }

  private async submit(): Promise<void> {
    const reset = this.mode === "reset";
    const ctx: RecoverContext = {
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
      await this.beforeReset();
      if (reset) {
        if (!this.password) {
          new Notice("SyncVault: account password required", 5000);
          return;
        }
        // Local safety check: refuse to wipe server history when this device
        // has nothing to seed, or we cannot verify it does.
        const count = await this.countSyncable();
        if (count <= 0) {
          new Notice(
            "SyncVault: no syncable files found on this device to seed. Recovering from here would leave the vault empty. Aborting.",
            8000,
          );
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
        new Notice(`SyncVault: server history wiped — uploading ${count} files...`, 6000);
      } else {
        // Pull the rebuilt baseline: download it without re-seeding this
        // device's files over it; divergent local files are overwritten by
        // the baseline (last-write-wins) instead of being preserved.
        await this.state.save({
          lastRevision: 0,
          seeded: true,
          appliedPaths: [],
          pendingChanges: [],
        });
        new Notice("SyncVault: pulling rebuilt baseline — local changes are overwritten...", 6000);
      }
      this.close();
      this.onDone();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      new Notice(`SyncVault: ${friendlyApiMessage(code, (e as Error).message)}`, 6000);
    }
  }
}
