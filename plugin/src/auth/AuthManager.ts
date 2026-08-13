import { SyncClient } from "../api/SyncClient";
import { SyncState } from "../state/SyncState";

export interface VaultInfo {
  vaultId: string;
  name: string;
}

export interface NewUserInput {
  accountId: string;
  password: string;
  vaultName: string;
  deviceName: string;
}

export interface ExistingUserInput {
  accountId: string;
  password: string;
  vaultId: string;
  vaultName: string;
  deviceName: string;
}

export class AuthManager {
  get accountId(): string | undefined {
    return this.state.accountId;
  }

  constructor(
    private state: SyncState,
    private client: SyncClient,
  ) {}

  static randomHex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  static suggestAccountId(): string {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    return `user${(n[0] % 9000) + 1000}`;
  }

  private async ensureDeviceId(): Promise<string> {
    if (this.state.deviceId) return this.state.deviceId;
    const deviceId = `dev_${AuthManager.randomHex(8)}`;
    await this.state.save({ deviceId });
    return deviceId;
  }

  async newUser(input: NewUserInput): Promise<void> {
    await this.client.createAccount(input.accountId.trim(), input.password);
    const vault = await this.client.createVault(input.accountId.trim(), input.password, input.vaultName.trim());
    const deviceId = await this.ensureDeviceId();
    const { deviceToken } = await this.client.registerDevice(
      input.accountId.trim(),
      vault.vaultId,
      input.password,
      deviceId,
      input.deviceName.trim() || "Obsidian",
    );
    await this.state.save({
      accountId: input.accountId.trim(),
      vaultId: vault.vaultId,
      vaultName: vault.name,
      deviceName: input.deviceName.trim() || "Obsidian",
      deviceToken,
      lastRevision: 0,
    });
  }

  async existingUser(input: ExistingUserInput): Promise<void> {
    await this.client.login(input.accountId.trim(), input.password);
    const deviceId = await this.ensureDeviceId();
    const { deviceToken } = await this.client.registerDevice(
      input.accountId.trim(),
      input.vaultId,
      input.password,
      deviceId,
      input.deviceName.trim() || "Obsidian",
    );
    await this.state.save({
      accountId: input.accountId.trim(),
      vaultId: input.vaultId,
      vaultName: input.vaultName,
      deviceName: input.deviceName.trim() || "Obsidian",
      deviceToken,
      lastRevision: 0,
    });
  }

  async fetchVaults(accountId: string, password: string): Promise<VaultInfo[]> {
    return this.client.listVaultsByPassword(accountId.trim(), password);
  }

  /**
   * Reconnect this device to its vault after authentication problems: the
   * server rotates the device token in place (same identity). Cursor, queue,
   * staging and journal are untouched.
   */
  async reconnect(password: string): Promise<void> {
    const accountId = this.state.accountId;
    const vaultId = this.state.vaultId;
    const deviceId = this.state.deviceId;
    if (!accountId || !vaultId || !deviceId) throw new Error("vault is not configured");
    const { deviceToken } = await this.client.registerDevice(
      accountId,
      vaultId,
      password,
      deviceId,
      this.state.deviceName ?? "Obsidian",
    );
    await this.state.save({ deviceToken });
  }
}