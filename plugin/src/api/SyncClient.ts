import { requestUrl } from "obsidian";
import { CHUNK_CAPABILITY, CHUNK_BYTES, type Change, type ContentReference } from "@syncvault/shared";

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

export type PushResult = { status: "accepted"; revision: number };

const TIMEOUTS = {
  auth: 10_000,
  ack: 10_000,
  pull: 15_000,
  push: 30_000,
  chunk: 30_000,
} as const;

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
      timeoutMs: TIMEOUTS.auth,
    });
  }

  async login(accountId: string, password: string): Promise<void> {
    await this.request("/v1/login", {
      method: "POST",
      body: { accountId, password },
      timeoutMs: TIMEOUTS.auth,
    });
  }

  async createVault(accountId: string, password: string, name: string): Promise<VaultInfo> {
    return this.request<VaultInfo>("/v1/vaults", {
      method: "POST",
      body: { accountId, password, name },
      timeoutMs: TIMEOUTS.auth,
    });
  }

  async listVaultsByPassword(accountId: string, password: string): Promise<VaultInfo[]> {
    const res = await this.request<{ vaults: VaultInfo[] }>("/v1/vaults/list", {
      method: "POST",
      body: { accountId, password },
      timeoutMs: TIMEOUTS.auth,
    });
    return res.vaults;
  }

  async listVaults(accountId: string, deviceId: string, token: string): Promise<VaultInfo[]> {
    const res = await this.request<{ vaults: VaultInfo[] }>("/v1/vaults", {
      headers: { Authorization: `Bearer ${accountId}:${deviceId}:${token}` },
      timeoutMs: TIMEOUTS.auth,
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
      timeoutMs: TIMEOUTS.auth,
    });
  }

  buildWsUrl(accountId: string, vaultId: string, deviceId: string): string {
    const wsBase = this.base.replace(/^http/, "ws");
    const params = new URLSearchParams({ accountId, deviceId });
    return `${wsBase}/v1/vaults/${vaultId}/ws?${params.toString()}`;
  }

  private async request<T>(
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
    const timeoutMs = opts.timeoutMs ?? TIMEOUTS.pull;
    const promise = requestUrl({
      url: `${this.base}${path}`,
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    // Obsidian's requestUrl has no timeout option; a suspended mobile request
    // must not be able to lock polling/uploading forever. Late results are
    // harmless because operations are idempotent and receipt-backed.
    const response = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new ApiError(0, "TIMEOUT", "request timed out")),
          timeoutMs,
        );
        void promise.finally(() => clearTimeout(timer));
      }),
    ]);
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

  async pullChanges(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    since: number,
  ): Promise<{
    currentRevision: number;
    minRetainedRevision: number;
    resyncRequired: boolean;
    changes: Change[];
  }> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    const res = await this.request<{
      currentRevision: number;
      minRetainedRevision: number;
      resyncRequired: boolean;
      changes: Change[];
    }>(`/v1/vaults/${vaultId}/sync?since=${since}&capabilities=${CHUNK_CAPABILITY}`, {
      headers: { Authorization: auth },
      timeoutMs: TIMEOUTS.pull,
    });
    return res;
  }

  async pushChange(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    change: Change,
  ): Promise<PushResult> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request<PushResult>(
      `/v1/vaults/${vaultId}/changes?capabilities=${CHUNK_CAPABILITY}`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: { ...change, deviceId },
        timeoutMs: TIMEOUTS.push,
      },
    );
  }

  /** Declares an upload for `change.content`; returns indexes already stored. */
  async beginUpload(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    change: Change,
  ): Promise<{ uploaded: number[]; acceptedRevision?: number }> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request<{ uploaded: number[]; acceptedRevision?: number }>(
      `/v1/vaults/${vaultId}/uploads`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: { ...change, deviceId },
        timeoutMs: TIMEOUTS.push,
      },
    );
  }

  async uploadChunk(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    operationId: string,
    index: number,
    data: Uint8Array,
  ): Promise<void> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request<{ ok: boolean }>(
      `/v1/vaults/${vaultId}/uploads/${encodeURIComponent(operationId)}/chunks/${index}`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: { data: this.toBase64(data) },
        timeoutMs: TIMEOUTS.chunk,
      },
    );
  }

  async completeUpload(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    operationId: string,
  ): Promise<PushResult> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request<PushResult>(
      `/v1/vaults/${vaultId}/uploads/${encodeURIComponent(operationId)}/complete`,
      {
        method: "POST",
        headers: { Authorization: auth },
        timeoutMs: TIMEOUTS.push,
      },
    );
  }

  async downloadChunk(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    revision: number,
    index: number,
  ): Promise<Uint8Array> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    const res = await this.request<{ data: string }>(
      `/v1/vaults/${vaultId}/revisions/${revision}/chunks/${index}`,
      { headers: { Authorization: auth }, timeoutMs: TIMEOUTS.chunk },
    );
    return this.fromBase64(res.data);
  }

  /**
   * Resumable upload of the bytes behind a content reference. Returns null on
   * a transient failure; the caller keeps the change queued.
   */
  async uploadContent(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    change: Change,
    bytes: Uint8Array,
  ): Promise<PushResult | null> {
    const content = change.content;
    if (!content) return null;
    const begin = await this.beginUpload(accountId, vaultId, deviceId, token, change);
    if (begin.acceptedRevision !== undefined) {
      return { status: "accepted", revision: begin.acceptedRevision };
    }
    const uploaded = new Set(begin.uploaded);
    let offset = 0;
    for (let i = 0; i < content.chunkCount; i++) {
      const end = Math.min(offset + CHUNK_BYTES, content.byteLength);
      if (!uploaded.has(i)) {
        await this.uploadChunk(accountId, vaultId, deviceId, token, change.operationId, i, bytes.subarray(offset, end));
      }
      offset = end;
    }
    return this.completeUpload(accountId, vaultId, deviceId, token, change.operationId);
  }

  /** Downloads and verifies the bytes behind a content reference. */
  async downloadContent(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    revision: number,
    content: ContentReference,
  ): Promise<Uint8Array | null> {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < content.chunkCount; i++) {
      parts.push(await this.downloadChunk(accountId, vaultId, deviceId, token, revision, i));
    }
    const joined = new Uint8Array(content.byteLength);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    if (offset !== content.byteLength) return null;
    const digest = await this.sha256Hex(joined);
    if (digest !== content.hash) return null;
    return joined;
  }

  private toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  private fromBase64(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  private async sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const view = new Uint8Array(digest);
    return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Repair operation: wipe the server's sync history for this vault so this
   * device can reseed it as a fresh baseline. Requires the account password
   * and a confirmation string (vault name or id) to prevent accidents.
   */
  async resetVault(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    password: string,
    confirm: string,
  ): Promise<void> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request<{ ok: boolean }>(`/v1/vaults/${vaultId}/reset`, {
      method: "POST",
      headers: { Authorization: auth },
      body: { accountId, password, confirm },
      timeoutMs: TIMEOUTS.auth,
    });
  }

  async sendAck(
    accountId: string,
    vaultId: string,
    deviceId: string,
    token: string,
    revision: number,
  ): Promise<void> {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request<{ ok: boolean }>(`/v1/vaults/${vaultId}/ack`, {
      method: "POST",
      headers: { Authorization: auth },
      body: { revision },
      timeoutMs: TIMEOUTS.ack,
    });
  }
}
