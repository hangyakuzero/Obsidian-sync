import { requestUrl } from "obsidian";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface VaultInfo {
  vaultId: string;
  name: string;
}

export class SyncClient {
  private base: string;

  constructor(serverUrl: string) {
    this.base = serverUrl.replace(/\/+$/, "");
  }

  setServerUrl(serverUrl: string): void {
    this.base = serverUrl.replace(/\/+$/, "");
  }

  async createAccount(accountId: string, password: string): Promise<void> {
    await this.request("/v1/accounts", {
      method: "POST",
      body: { accountId, password },
    });
  }

  async login(accountId: string, password: string): Promise<void> {
    await this.request("/v1/login", { method: "POST", body: { accountId, password } });
  }

  async createVault(accountId: string, password: string, name: string): Promise<VaultInfo> {
    return this.request<VaultInfo>("/v1/vaults", {
      method: "POST",
      body: { accountId, password, name },
    });
  }

  async listVaultsByPassword(accountId: string, password: string): Promise<VaultInfo[]> {
    const res = await this.request<{ vaults: VaultInfo[] }>("/v1/vaults/list", {
      method: "POST",
      body: { accountId, password },
    });
    return res.vaults;
  }

  async listVaults(accountId: string, deviceId: string, token: string): Promise<VaultInfo[]> {
    const res = await this.request<{ vaults: VaultInfo[] }>("/v1/vaults", {
      headers: { Authorization: `Bearer ${accountId}:${deviceId}:${token}` },
    });
    return res.vaults;
  }

  async registerDevice(
    accountId: string,
    vaultId: string,
    password: string,
    deviceId: string,
    deviceName: string,
  ): Promise<{ deviceToken: string }> {
    return this.request<{ deviceToken: string }>(`/v1/vaults/${vaultId}/devices`, {
      method: "POST",
      body: { accountId, password, deviceId, name: deviceName },
    });
  }

  buildWsUrl(accountId: string, vaultId: string, deviceId: string): string {
    const wsBase = this.base.replace(/^http/, "ws");
    const params = new URLSearchParams({ accountId, deviceId });
    return `${wsBase}/v1/vaults/${vaultId}/ws?${params.toString()}`;
  }

  private async request<T>(
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
    const response = await requestUrl({
      url: `${this.base}${path}`,
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (response.status >= 400) {
      let code = "INTERNAL";
      let message = response.text || "request failed";
      try {
        const parsed = JSON.parse(response.text) as { error?: string; message?: string };
        code = parsed.error ?? code;
        message = parsed.message ?? message;
      } catch {
        // keep defaults
      }
      throw new ApiError(response.status, code, message);
    }
    return response.json as T;
  }
}
