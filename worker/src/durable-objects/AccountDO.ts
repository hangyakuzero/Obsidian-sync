import { DurableObject } from "cloudflare:workers";
import {
  hashPassword,
  hashToken,
  randomHex,
  timingSafeEqual,
  validateAccountId,
  validateDeviceId,
  verifyPassword,
} from "../auth";
import type { Env } from "../env";

export interface VaultInfo {
  vaultId: string;
  name: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: string, message: string): Result<never> => ({ ok: false, code, message });

export class AccountDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          account_id TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vaults (
          vault_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          vault_id TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_vaults_account ON vaults(account_id);
        CREATE INDEX IF NOT EXISTS idx_devices_vault ON devices(vault_id);
      `);
    });
  }

  async createAccount(accountId: string, password: string): Promise<Result<{ accountId: string }>> {
    if (!validateAccountId(accountId)) return fail("BAD_REQUEST", "accountId must be 3-64 chars: lowercase letters, digits, hyphens");
    if (typeof password !== "string" || password.length < 8 || password.length > 200) {
      return fail("BAD_REQUEST", "password must be 8-200 chars");
    }
    const passwordHash = await hashPassword(password);
    const existing = this.ctx.storage.sql
      .exec<{ account_id: string }>("SELECT account_id FROM accounts WHERE account_id = ?", accountId)
      .toArray()[0];
    if (existing) return fail("CONFLICT", "account already exists");
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO accounts (account_id, password_hash, created_at) VALUES (?, ?, ?)",
        accountId,
        passwordHash,
        Date.now(),
      );
    } catch {
      // concurrent create won the race; uniqueness is enforced by the PK
      return fail("CONFLICT", "account already exists");
    }
    return ok({ accountId });
  }

  async verifyLogin(accountId: string, password: string): Promise<Result<null>> {
    const row = this.ctx.storage.sql
      .exec<{ password_hash: string }>("SELECT password_hash FROM accounts WHERE account_id = ?", accountId)
      .toArray()[0];
    if (!row) return fail("NOT_FOUND", "account not found");
    if (!(await verifyPassword(password, row.password_hash))) {
      return fail("UNAUTHORIZED", "invalid password");
    }
    return ok(null);
  }

  async createVault(accountId: string, name: string): Promise<Result<VaultInfo>> {
    const nameTrimmed = name.trim();
    if (!nameTrimmed || nameTrimmed.length > 100) {
      return fail("BAD_REQUEST", "vault name must be 1-100 chars");
    }
    const vaultId = `v_${randomHex(12)}`;
    this.ctx.storage.sql.exec(
      "INSERT INTO vaults (vault_id, account_id, name, created_at) VALUES (?, ?, ?, ?)",
      vaultId,
      accountId,
      nameTrimmed,
      Date.now(),
    );
    await this.env.VAULT_DO.getByName(vaultId).initVault();
    return ok({ vaultId, name: nameTrimmed });
  }

  async listVaults(accountId: string, deviceId: string, token: string): Promise<Result<VaultInfo[]>> {
    const device = this.ctx.storage.sql
      .exec<{ token_hash: string }>(
        "SELECT token_hash FROM devices WHERE device_id = ? AND account_id = ?",
        deviceId,
        accountId,
      )
      .toArray()[0];
    if (!device) return fail("UNAUTHORIZED", "unknown device");
    if (!(await this.verifyToken(token, device.token_hash))) {
      return fail("UNAUTHORIZED", "invalid token");
    }
    return ok(this.vaultRowsFor(accountId));
  }

  async listVaultsByPassword(accountId: string, password: string): Promise<Result<VaultInfo[]>> {
    const login = await this.verifyLogin(accountId, password);
    if (!login.ok) return login;
    return ok(this.vaultRowsFor(accountId));
  }

  async getVault(accountId: string, vaultId: string): Promise<Result<VaultInfo>> {
    const row = this.ctx.storage.sql
      .exec<{ vault_id: string; name: string }>(
        "SELECT vault_id, name FROM vaults WHERE vault_id = ? AND account_id = ?",
        vaultId,
        accountId,
      )
      .toArray()[0];
    if (!row) return fail("NOT_FOUND", "vault not found");
    return ok({ vaultId: row.vault_id, name: row.name });
  }

  private vaultRowsFor(accountId: string): VaultInfo[] {
    return this.ctx.storage.sql
      .exec<{ vault_id: string; name: string }>(
        "SELECT vault_id, name FROM vaults WHERE account_id = ? ORDER BY created_at",
        accountId,
      )
      .toArray()
      .map((r) => ({ vaultId: r.vault_id, name: r.name }));
  }

  async registerDevice(
    accountId: string,
    vaultId: string,
    password: string,
    deviceId: string,
    name: string,
  ): Promise<Result<{ deviceToken: string }>> {
    if (!validateDeviceId(deviceId)) {
      return fail("BAD_REQUEST", "deviceId must be 8-64 chars: letters, digits, underscore, hyphen");
    }
    const login = await this.verifyLogin(accountId, password);
    if (!login.ok) return login;
    const vault = this.ctx.storage.sql
      .exec<{ vault_id: string }>(
        "SELECT vault_id FROM vaults WHERE vault_id = ? AND account_id = ?",
        vaultId,
        accountId,
      )
      .toArray()[0];
    if (!vault) return fail("NOT_FOUND", "vault not found");

    const existing = this.ctx.storage.sql
      .exec<{ account_id: string; vault_id: string }>(
        "SELECT account_id, vault_id FROM devices WHERE device_id = ?",
        deviceId,
      )
      .toArray()[0];
    if (existing) {
      if (existing.account_id !== accountId || existing.vault_id !== vaultId) {
        return fail("CONFLICT", "device already registered");
      }
      // Same identity re-registering (e.g. reconnect after a lost token):
      // rotate the token in place instead of locking the device out.
      const deviceToken = randomHex(32);
      const tokenHash = await hashToken(deviceToken);
      this.ctx.storage.sql.exec(
        "UPDATE devices SET token_hash = ?, name = ? WHERE device_id = ?",
        tokenHash,
        (name || "device").slice(0, 100),
        deviceId,
      );
      return ok({ deviceToken });
    }

    const deviceToken = randomHex(32);
    const tokenHash = await hashToken(deviceToken);
    this.ctx.storage.sql.exec(
      "INSERT INTO devices (device_id, account_id, vault_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      deviceId,
      accountId,
      vaultId,
      tokenHash,
      (name || "device").slice(0, 100),
      Date.now(),
    );
    await this.env.VAULT_DO.getByName(vaultId).registerDevice(deviceId, name);
    return ok({ deviceToken });
  }

  async verifyDevice(accountId: string, deviceId: string, token: string, vaultId: string): Promise<boolean> {
    const device = this.ctx.storage.sql
      .exec<{ token_hash: string; vault_id: string }>(
        "SELECT token_hash, vault_id FROM devices WHERE device_id = ? AND account_id = ?",
        deviceId,
        accountId,
      )
      .toArray()[0];
    if (!device) return false;
    if (device.vault_id !== vaultId) return false;
    return this.verifyToken(token, device.token_hash);
  }

  private async verifyToken(token: string, tokenHash: string): Promise<boolean> {
    const actual = await hashToken(token);
    const encoder = new TextEncoder();
    return timingSafeEqual(encoder.encode(actual), encoder.encode(tokenHash));
  }
}