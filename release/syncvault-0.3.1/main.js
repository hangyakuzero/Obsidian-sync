var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SyncVaultPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");

// src/ui/SettingsTab.ts
var import_obsidian5 = require("obsidian");

// src/ui/WelcomeModal.ts
var import_obsidian2 = require("obsidian");

// src/auth/AuthManager.ts
var AuthManager = class _AuthManager {
  constructor(state, client) {
    this.state = state;
    this.client = client;
  }
  get accountId() {
    return this.state.accountId;
  }
  static randomHex(bytes) {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  static suggestAccountId() {
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    return `user${n[0] % 9e3 + 1e3}`;
  }
  async ensureDeviceId() {
    if (this.state.deviceId) return this.state.deviceId;
    const deviceId = `dev_${_AuthManager.randomHex(8)}`;
    await this.state.save({ deviceId });
    return deviceId;
  }
  async newUser(input) {
    await this.client.createAccount(input.accountId.trim(), input.password);
    const vault = await this.client.createVault(input.accountId.trim(), input.password, input.vaultName.trim());
    const deviceId = await this.ensureDeviceId();
    const { deviceToken } = await this.client.registerDevice(
      input.accountId.trim(),
      vault.vaultId,
      input.password,
      deviceId,
      input.deviceName.trim() || "Obsidian"
    );
    await this.state.save({
      accountId: input.accountId.trim(),
      vaultId: vault.vaultId,
      vaultName: vault.name,
      deviceName: input.deviceName.trim() || "Obsidian",
      deviceToken,
      lastRevision: 0
    });
  }
  async existingUser(input) {
    await this.client.login(input.accountId.trim(), input.password);
    const deviceId = await this.ensureDeviceId();
    const { deviceToken } = await this.client.registerDevice(
      input.accountId.trim(),
      input.vaultId,
      input.password,
      deviceId,
      input.deviceName.trim() || "Obsidian"
    );
    await this.state.save({
      accountId: input.accountId.trim(),
      vaultId: input.vaultId,
      vaultName: input.vaultName,
      deviceName: input.deviceName.trim() || "Obsidian",
      deviceToken,
      lastRevision: 0
    });
  }
  async fetchVaults(accountId, password) {
    return this.client.listVaultsByPassword(accountId.trim(), password);
  }
  /**
   * Reconnect this device to its vault after authentication problems: the
   * server rotates the device token in place (same identity). Cursor, queue,
   * staging and journal are untouched.
   */
  async reconnect(password) {
    var _a;
    const accountId = this.state.accountId;
    const vaultId = this.state.vaultId;
    const deviceId = this.state.deviceId;
    if (!accountId || !vaultId || !deviceId) throw new Error("vault is not configured");
    const { deviceToken } = await this.client.registerDevice(
      accountId,
      vaultId,
      password,
      deviceId,
      (_a = this.state.deviceName) != null ? _a : "Obsidian"
    );
    await this.state.save({ deviceToken });
  }
};

// src/api/SyncClient.ts
var import_obsidian = require("obsidian");

// ../shared/src/index.ts
var MAX_FILE_BYTES = 16 * 1024 * 1024;
var MAX_INLINE_BYTES = 1024 * 1024;
var CHUNK_BYTES = 256 * 1024;
var CHUNK_CAPABILITY = "chunks-v1";
var RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
var MAX_PATH_LENGTH = 1024;
function normalizePath(raw) {
  const parts = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error("invalid path: ..");
    if (part.includes("\\") || part.includes("\0")) throw new Error("invalid path segment");
    parts.push(part);
  }
  const path = parts.join("/");
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) throw new Error("invalid path length");
  return path;
}
function toBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function isValidBase64(base64) {
  if (base64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.includes("=") && base64.length % 4 !== 0) {
    return false;
  }
  try {
    fromBase64(base64);
    return true;
  } catch (e) {
    return false;
  }
}
function isValidHash(hash) {
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
}
function isValidContentReference(content) {
  if (!content || typeof content !== "object") return false;
  const value = content;
  return isValidHash(value.hash) && typeof value.byteLength === "number" && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0 && value.byteLength <= MAX_FILE_BYTES && typeof value.chunkCount === "number" && Number.isSafeInteger(value.chunkCount) && value.chunkCount === Math.max(1, Math.ceil(value.byteLength / CHUNK_BYTES));
}

// src/api/SyncClient.ts
var ApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
};
var TIMEOUTS = {
  auth: 1e4,
  ack: 1e4,
  pull: 15e3,
  push: 3e4,
  chunk: 3e4
};
var SyncClient = class {
  constructor(serverUrl) {
    this.base = serverUrl.replace(/\/+$/, "");
  }
  setServerUrl(serverUrl) {
    this.base = serverUrl.replace(/\/+$/, "");
  }
  async createAccount(accountId, password) {
    await this.request("/v1/accounts", {
      method: "POST",
      body: { accountId, password },
      timeoutMs: TIMEOUTS.auth
    });
  }
  async login(accountId, password) {
    await this.request("/v1/login", {
      method: "POST",
      body: { accountId, password },
      timeoutMs: TIMEOUTS.auth
    });
  }
  async createVault(accountId, password, name) {
    return this.request("/v1/vaults", {
      method: "POST",
      body: { accountId, password, name },
      timeoutMs: TIMEOUTS.auth
    });
  }
  async listVaultsByPassword(accountId, password) {
    const res = await this.request("/v1/vaults/list", {
      method: "POST",
      body: { accountId, password },
      timeoutMs: TIMEOUTS.auth
    });
    return res.vaults;
  }
  async listVaults(accountId, deviceId, token) {
    const res = await this.request("/v1/vaults", {
      headers: { Authorization: `Bearer ${accountId}:${deviceId}:${token}` },
      timeoutMs: TIMEOUTS.auth
    });
    return res.vaults;
  }
  async registerDevice(accountId, vaultId, password, deviceId, deviceName) {
    return this.request(`/v1/vaults/${vaultId}/devices`, {
      method: "POST",
      body: { accountId, password, deviceId, name: deviceName },
      timeoutMs: TIMEOUTS.auth
    });
  }
  buildWsUrl(accountId, vaultId, deviceId) {
    const wsBase = this.base.replace(/^http/, "ws");
    const params = new URLSearchParams({ accountId, deviceId });
    return `${wsBase}/v1/vaults/${vaultId}/ws?${params.toString()}`;
  }
  async request(path, opts = {}) {
    var _a, _b, _c, _d;
    const headers = { "Content-Type": "application/json", ...opts.headers };
    const timeoutMs = (_a = opts.timeoutMs) != null ? _a : TIMEOUTS.pull;
    const promise = (0, import_obsidian.requestUrl)({
      url: `${this.base}${path}`,
      method: (_b = opts.method) != null ? _b : "GET",
      headers,
      body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0
    });
    const response = await Promise.race([
      promise,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new ApiError(0, "TIMEOUT", "request timed out")),
          timeoutMs
        );
        void promise.finally(() => clearTimeout(timer));
      })
    ]);
    if (response.status >= 400) {
      let code = "INTERNAL";
      let message = response.text || "request failed";
      try {
        const parsed = JSON.parse(response.text);
        code = (_c = parsed.error) != null ? _c : code;
        message = (_d = parsed.message) != null ? _d : message;
      } catch (e) {
      }
      throw new ApiError(response.status, code, message);
    }
    return response.json;
  }
  async pullChanges(accountId, vaultId, deviceId, token, since) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    const res = await this.request(`/v1/vaults/${vaultId}/sync?since=${since}&capabilities=${CHUNK_CAPABILITY}`, {
      headers: { Authorization: auth },
      timeoutMs: TIMEOUTS.pull
    });
    return res;
  }
  async pushChange(accountId, vaultId, deviceId, token, change) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request(
      `/v1/vaults/${vaultId}/changes?capabilities=${CHUNK_CAPABILITY}`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: { ...change, deviceId },
        timeoutMs: TIMEOUTS.push
      }
    );
  }
  /** Declares an upload for `change.content`; returns indexes already stored. */
  async beginUpload(accountId, vaultId, deviceId, token, change) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request(
      `/v1/vaults/${vaultId}/uploads`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: { ...change, deviceId },
        timeoutMs: TIMEOUTS.push
      }
    );
  }
  async uploadChunk(accountId, vaultId, deviceId, token, operationId, index, data) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request(
      `/v1/vaults/${vaultId}/uploads/${encodeURIComponent(operationId)}/chunks/${index}`,
      {
        method: "POST",
        headers: { Authorization: auth },
        body: { data: this.toBase64(data) },
        timeoutMs: TIMEOUTS.chunk
      }
    );
  }
  async completeUpload(accountId, vaultId, deviceId, token, operationId) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request(
      `/v1/vaults/${vaultId}/uploads/${encodeURIComponent(operationId)}/complete`,
      {
        method: "POST",
        headers: { Authorization: auth },
        timeoutMs: TIMEOUTS.push
      }
    );
  }
  async downloadChunk(accountId, vaultId, deviceId, token, revision, index) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    const res = await this.request(
      `/v1/vaults/${vaultId}/revisions/${revision}/chunks/${index}`,
      { headers: { Authorization: auth }, timeoutMs: TIMEOUTS.chunk }
    );
    return this.fromBase64(res.data);
  }
  /**
   * Resumable upload of the bytes behind a content reference. Returns null on
   * a transient failure; the caller keeps the change queued.
   */
  async uploadContent(accountId, vaultId, deviceId, token, change, bytes) {
    const content = change.content;
    if (!content) return null;
    const begin = await this.beginUpload(accountId, vaultId, deviceId, token, change);
    if (begin.acceptedRevision !== void 0) {
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
  async downloadContent(accountId, vaultId, deviceId, token, revision, content) {
    const parts = [];
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
  toBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  fromBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const view = new Uint8Array(digest);
    return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  /**
   * Repair operation: wipe the server's sync history for this vault so this
   * device can reseed it as a fresh baseline. Requires the account password
   * and a confirmation string (vault name or id) to prevent accidents.
   */
  async resetVault(accountId, vaultId, deviceId, token, password, confirm) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request(`/v1/vaults/${vaultId}/reset`, {
      method: "POST",
      headers: { Authorization: auth },
      body: { accountId, password, confirm },
      timeoutMs: TIMEOUTS.auth
    });
  }
  async sendAck(accountId, vaultId, deviceId, token, revision) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request(`/v1/vaults/${vaultId}/ack`, {
      method: "POST",
      headers: { Authorization: auth },
      body: { revision },
      timeoutMs: TIMEOUTS.ack
    });
  }
};

// src/ui/friendlyErrors.ts
function friendlyApiMessage(code, raw) {
  switch (code) {
    case "CONFLICT":
      return "Username already exists. Choose another username or select Existing user.";
    case "NOT_FOUND":
      return "Username not found.";
    case "UNAUTHORIZED":
      return "Password rejected. Check your password and try again.";
    case "BAD_REQUEST":
      return raw || "Invalid input. Check your username and password.";
    case "PAYLOAD_REQUIRED":
      return "This file has no content and cannot be synced.";
    default:
      return raw || "Something went wrong.";
  }
}

// src/ui/WelcomeModal.ts
var WelcomeModal = class extends import_obsidian2.Modal {
  constructor(app, auth, onDone) {
    super(app);
    this.auth = auth;
    this.onDone = onDone;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncvault-modal");
    contentEl.createEl("h2", { text: "Welcome to SyncVault" });
    contentEl.createEl("p", { text: "Synchronize this vault between your devices." });
    new import_obsidian2.Setting(contentEl).addButton(
      (b) => b.setButtonText("New user").setCta().onClick(() => {
        this.close();
        new NewUserModal(this.app, this.auth, this.onDone).open();
      })
    ).addButton(
      (b) => b.setButtonText("Existing user").onClick(() => {
        this.close();
        new ExistingUserModal(this.app, this.auth, this.onDone).open();
      })
    );
  }
};
var NewUserModal = class extends import_obsidian2.Modal {
  constructor(app, auth, onDone) {
    super(app);
    this.auth = auth;
    this.onDone = onDone;
    this.password = "";
    this.vaultName = "";
    this.deviceName = "";
    this.accountId = AuthManager.suggestAccountId();
    this.deviceName = this.platformName();
  }
  platformName() {
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
    return "Desktop";
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncvault-modal");
    contentEl.createEl("h2", { text: "Create account" });
    if (this.deviceName === "Desktop") {
      this.deviceName = "Desktop";
    }
    new import_obsidian2.Setting(contentEl).setName("Account ID").addText((t) => {
      t.setValue(this.accountId);
      t.onChange((v) => this.accountId = v.trim());
    });
    new import_obsidian2.Setting(contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => this.password = v);
    });
    new import_obsidian2.Setting(contentEl).setName("Vault name").addText((t) => {
      t.setValue("My Notes");
      t.onChange((v) => this.vaultName = v.trim());
    });
    new import_obsidian2.Setting(contentEl).setName("Device name").addText((t) => {
      t.setValue(this.deviceName);
      t.onChange((v) => this.deviceName = v.trim());
    });
    new import_obsidian2.Setting(contentEl).addButton(
      (b) => b.setButtonText("Create").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          await this.auth.newUser({
            accountId: this.accountId,
            password: this.password,
            vaultName: this.vaultName || "My Notes",
            deviceName: this.deviceName
          });
          new import_obsidian2.Notice("SyncVault: account and vault created");
          this.close();
          this.onDone();
        } catch (e) {
          new import_obsidian2.Notice(`SyncVault: ${friendlyApiMessage(e instanceof ApiError ? e.code : void 0, e.message)}`, 6e3);
          b.setDisabled(false);
        }
      })
    );
  }
};
var ExistingUserModal = class extends import_obsidian2.Modal {
  constructor(app, auth, onDone) {
    super(app);
    this.auth = auth;
    this.onDone = onDone;
    this.accountId = "";
    this.password = "";
    this.deviceName = "";
    this.vaults = [];
    this.selectedVaultId = "";
    this.pickerRendered = false;
    const ua = navigator.userAgent;
    this.deviceName = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : "Desktop";
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncvault-modal");
    contentEl.createEl("h2", { text: "Sign in" });
    new import_obsidian2.Setting(contentEl).setName("Account ID").addText((t) => {
      t.setPlaceholder("user1234");
      t.onChange((v) => this.accountId = v.trim());
    });
    new import_obsidian2.Setting(contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => this.password = v);
    });
    new import_obsidian2.Setting(contentEl).setName("Device name").addText((t) => {
      t.setValue(this.deviceName);
      t.onChange((v) => this.deviceName = v.trim());
    });
    new import_obsidian2.Setting(contentEl).addButton(
      (b) => b.setButtonText("Sign in").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          this.vaults = await this.auth.fetchVaults(this.accountId, this.password);
        } catch (e) {
          new import_obsidian2.Notice(`SyncVault: ${friendlyApiMessage(e instanceof ApiError ? e.code : void 0, e.message)}`, 6e3);
          b.setDisabled(false);
          return;
        }
        if (this.vaults.length === 0) {
          new import_obsidian2.Notice("SyncVault: no vaults found", 6e3);
          b.setDisabled(false);
          return;
        }
        this.selectedVaultId = this.vaults[0].vaultId;
        this.renderVaultPicker();
      })
    );
  }
  renderVaultPicker() {
    if (this.pickerRendered) return;
    this.pickerRendered = true;
    const { contentEl } = this;
    const setting = new import_obsidian2.Setting(contentEl).setName("Vault to sync");
    setting.addDropdown((d) => {
      for (const v of this.vaults) d.addOption(v.vaultId, v.name);
      d.onChange((v) => this.selectedVaultId = v);
    });
    new import_obsidian2.Setting(contentEl).addButton(
      (b) => b.setButtonText("Link this vault").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          const vault = this.vaults.find((v) => v.vaultId === this.selectedVaultId);
          await this.auth.existingUser({
            accountId: this.accountId,
            password: this.password,
            vaultId: this.selectedVaultId,
            vaultName: vault ? vault.name : "",
            deviceName: this.deviceName
          });
          new import_obsidian2.Notice("SyncVault: vault linked");
          this.close();
          this.onDone();
        } catch (e) {
          new import_obsidian2.Notice(`SyncVault: ${friendlyApiMessage(e instanceof ApiError ? e.code : void 0, e.message)}`, 6e3);
          b.setDisabled(false);
        }
      })
    );
  }
};

// src/ui/RecoverModal.ts
var import_obsidian3 = require("obsidian");
var RecoverModal = class extends import_obsidian3.Modal {
  constructor(app, state, client, mode, onDone, beforeReset, countSyncable) {
    super(app);
    this.state = state;
    this.client = client;
    this.mode = mode;
    this.onDone = onDone;
    this.beforeReset = beforeReset;
    this.countSyncable = countSyncable;
    this.password = "";
  }
  onOpen() {
    var _a, _b;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncvault-modal");
    const reset = this.mode === "reset";
    contentEl.createEl("h2", { text: "Recover sync" });
    contentEl.createEl("p", {
      text: reset ? "Your vault's sync history is corrupted or unusable. This device becomes the new baseline: the server's sync history for this vault is wiped (nothing on any device is deleted), then every local file below is uploaded with its real content." : "This device downloads the rebuilt baseline from the server. Local files that differ from the baseline are overwritten by it; nothing is preserved as a conflict copy."
    });
    contentEl.createEl("p", { text: `Vault: ${(_b = (_a = this.state.vaultName) != null ? _a : this.state.vaultId) != null ? _b : "?"}` });
    if (reset) {
      new import_obsidian3.Setting(contentEl).setName("Account password").addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("required \u2014 confirms you own this account");
        t.onChange((v) => this.password = v);
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void this.submit();
        });
      });
    }
    new import_obsidian3.Setting(contentEl).addButton(
      (b) => b.setButtonText(reset ? "Reset baseline from this device" : "Pull rebuilt baseline").setWarning().onClick(() => void this.submit())
    ).addButton(
      (b) => b.setButtonText("Cancel").onClick(() => this.close())
    );
  }
  async submit() {
    var _a;
    const reset = this.mode === "reset";
    const ctx = {
      accountId: this.state.accountId,
      vaultId: this.state.vaultId,
      vaultName: this.state.vaultName,
      deviceId: this.state.deviceId,
      deviceToken: this.state.deviceToken
    };
    if (!ctx.accountId || !ctx.vaultId || !ctx.deviceId || !ctx.deviceToken) {
      new import_obsidian3.Notice("SyncVault: not linked; reconnect first", 6e3);
      return;
    }
    try {
      await this.beforeReset();
      if (reset) {
        if (!this.password) {
          new import_obsidian3.Notice("SyncVault: account password required", 5e3);
          return;
        }
        const count = await this.countSyncable();
        if (count <= 0) {
          new import_obsidian3.Notice(
            "SyncVault: no syncable files found on this device to seed. Recovering from here would leave the vault empty. Aborting.",
            8e3
          );
          return;
        }
        const confirm = (_a = ctx.vaultName) != null ? _a : ctx.vaultId;
        await this.client.resetVault(
          ctx.accountId,
          ctx.vaultId,
          ctx.deviceId,
          ctx.deviceToken,
          this.password,
          confirm
        );
        await this.state.save({
          lastRevision: 0,
          seeded: false,
          appliedPaths: [],
          pendingChanges: []
        });
        new import_obsidian3.Notice(`SyncVault: server history wiped \u2014 uploading ${count} files...`, 6e3);
      } else {
        await this.state.save({
          lastRevision: 0,
          seeded: true,
          appliedPaths: [],
          pendingChanges: []
        });
        new import_obsidian3.Notice("SyncVault: pulling rebuilt baseline \u2014 local changes are overwritten...", 6e3);
      }
      this.close();
      this.onDone();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : void 0;
      new import_obsidian3.Notice(`SyncVault: ${friendlyApiMessage(code, e.message)}`, 6e3);
    }
  }
};

// src/ui/ReconnectModal.ts
var import_obsidian4 = require("obsidian");
var ReconnectModal = class extends import_obsidian4.Modal {
  constructor(app, auth, onDone) {
    super(app);
    this.auth = auth;
    this.onDone = onDone;
    this.password = "";
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("syncvault-modal");
    contentEl.createEl("h2", { text: "Reconnect vault" });
    contentEl.createEl("p", {
      text: "Rotates this device's sync token so syncing can resume. Your files, pending changes and sync history are kept."
    });
    contentEl.createEl("p", { text: `Account: ${this.auth.accountId}` });
    new import_obsidian4.Setting(contentEl).setName("Account password").addText((t) => {
      t.inputEl.type = "password";
      t.setPlaceholder("required \u2014 confirms you own this account");
      t.onChange((v) => this.password = v);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this.submit();
      });
    });
    new import_obsidian4.Setting(contentEl).addButton(
      (b) => b.setButtonText("Reconnect").setCta().onClick(() => void this.submit())
    ).addButton(
      (b) => b.setButtonText("Cancel").onClick(() => this.close())
    );
  }
  async submit() {
    if (!this.password) {
      new import_obsidian4.Notice("SyncVault: enter your account password");
      return;
    }
    try {
      await this.auth.reconnect(this.password);
      this.close();
      new import_obsidian4.Notice("SyncVault: reconnected \u2014 resuming sync");
      this.onDone();
    } catch (e) {
      const err = e;
      new import_obsidian4.Notice(`SyncVault: ${friendlyApiMessage(err.code, err.message)}`, 6e3);
    }
  }
};

// src/ui/SettingsTab.ts
var STATUS_LABELS = {
  idle: "idle",
  syncing: "\u21BB Syncing",
  downloading: "\u2193 Downloading",
  uploading: "\u2191 Uploading",
  offline: "\u2715 Offline",
  synced: "\u2713 Synced",
  paused: "\u23F8 Paused"
};
var SyncVaultSettingsTab = class extends import_obsidian5.PluginSettingTab {
  constructor(app, plugin, state, auth, client, engine, afterSetup) {
    super(app, plugin);
    this.plugin = plugin;
    this.state = state;
    this.auth = auth;
    this.client = client;
    this.engine = engine;
    this.afterSetup = afterSetup;
  }
  display() {
    var _a, _b, _c, _d, _e;
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("syncvault-settings");
    containerEl.createEl("h2", { text: "SyncVault" });
    new import_obsidian5.Setting(containerEl).setName("Server URL").addText((t) => {
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
    new import_obsidian5.Setting(containerEl).setName("Account").setDesc((_a = this.state.accountId) != null ? _a : "");
    new import_obsidian5.Setting(containerEl).setName("Vault").setDesc((_c = (_b = this.state.vaultName) != null ? _b : this.state.vaultId) != null ? _c : "");
    new import_obsidian5.Setting(containerEl).setName("Device").setDesc((_e = (_d = this.state.deviceName) != null ? _d : this.state.deviceId) != null ? _e : "");
    new import_obsidian5.Setting(containerEl).setName("Status").setDesc(
      `${STATUS_LABELS[this.engine.status]} \xB7 revision ${this.state.lastRevision} \xB7 ${this.engine.pendingCount} pending`
    );
    new import_obsidian5.Setting(containerEl).addButton(
      (b) => b.setButtonText("Sync now").setCta().onClick(() => {
        void this.engine.syncNow().then(() => this.display());
      })
    );
    if (this.engine.isPaused) {
      new import_obsidian5.Setting(containerEl).setName("Sync paused").setDesc("A remote change could not be applied, so polling stopped.").addButton(
        (b) => b.setButtonText("Resume sync").setCta().onClick(() => {
          void this.engine.resume().then(() => this.display());
        })
      );
    }
    const visualEnabled = this.state.visualSync;
    new import_obsidian5.Setting(containerEl).setName("Sync visual appearance").setDesc(
      "Mirrors appearance.json and installed themes between devices. " + (this.plugin.lastVisualApplyAt > 0 ? "Changes will apply after Obsidian restarts." : "Applied appearances take effect after Obsidian restarts.")
    ).addToggle(
      (t) => t.setValue(visualEnabled).setTooltip("Mirror themes and selected appearance between devices").onChange((v) => {
        void this.state.save({ visualSync: v }).then(() => this.display());
      })
    ).addButton(
      (b) => b.setButtonText("Sync visual files now").onClick(() => {
        this.plugin.syncVisualNow();
        new import_obsidian5.Notice("SyncVault: visual files queued for sync");
      })
    );
    new import_obsidian5.Setting(containerEl).setName("Recover sync \u2014 reset baseline").setDesc("Last resort when the server history is unusable (e.g. old builds uploaded files without content). This device becomes the new baseline and re-uploads all its files.").addButton(
      (b) => b.setButtonText("Reset baseline from this device").setWarning().onClick(() => {
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
          () => this.engine.countSyncableFiles()
        ).open();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("Recover sync \u2014 join rebuilt baseline").setDesc("Download the rebuilt baseline to this device. Local files are overwritten by the baseline; no conflict copies are created.").addButton(
      (b) => b.setButtonText("Pull rebuilt baseline").setWarning().onClick(() => {
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
          () => this.engine.countSyncableFiles()
        ).open();
      })
    );
    new import_obsidian5.Setting(containerEl).setName("Reconnect vault").setDesc("Rotate this device's sync token after authentication problems. Files, pending changes and sync state are kept.").addButton(
      (b) => b.setButtonText("Reconnect").setCta().onClick(() => {
        new ReconnectModal(this.app, this.auth, () => {
          this.engine.authRecovered();
          this.display();
        }).open();
      })
    );
    new import_obsidian5.Setting(containerEl).addButton(
      (b) => b.setButtonText("Disconnect vault").onClick(async () => {
        this.engine.stop();
        await this.state.disconnect();
        new import_obsidian5.Notice("SyncVault: vault disconnected");
        this.display();
      })
    );
  }
  renderWelcome(parent) {
    parent.createEl("p", { text: "Welcome to SyncVault. Link this vault to sync it between your devices." });
    new import_obsidian5.Setting(parent).addButton(
      (b) => b.setButtonText("Set up SyncVault").setCta().onClick(() => {
        new WelcomeModal(this.app, this.auth, () => {
          var _a;
          this.display();
          (_a = this.afterSetup) == null ? void 0 : _a.call(this);
        }).open();
      })
    );
  }
};

// src/state/SyncState.ts
var DEFAULT_SYNC_DATA = {
  serverUrl: "https://syncvault.hangyakuzero.workers.dev",
  lastRevision: 0,
  pendingChanges: [],
  seeded: false,
  appliedPaths: [],
  journal: [],
  visualSync: true
};
var SyncState = class {
  constructor(backend) {
    this.backend = backend;
    this.loaded = Promise.resolve();
    this.writeQueue = Promise.resolve();
    this.data = { ...DEFAULT_SYNC_DATA, pendingChanges: [], journal: [], appliedPaths: [] };
  }
  get connected() {
    return Boolean(
      this.data.accountId && this.data.vaultId && this.data.deviceId && this.data.deviceToken
    );
  }
  get serverUrl() {
    return this.data.serverUrl;
  }
  get visualSync() {
    return this.data.visualSync === true;
  }
  get accountId() {
    return this.data.accountId;
  }
  get vaultId() {
    return this.data.vaultId;
  }
  get vaultName() {
    return this.data.vaultName;
  }
  get deviceId() {
    return this.data.deviceId;
  }
  get deviceName() {
    return this.data.deviceName;
  }
  get deviceToken() {
    return this.data.deviceToken;
  }
  get lastRevision() {
    return this.data.lastRevision;
  }
  get pendingChanges() {
    return this.data.pendingChanges;
  }
  get journal() {
    return this.data.journal;
  }
  async load() {
    this.loaded = (async () => {
      var _a;
      const saved = await ((_a = this.backend) == null ? void 0 : _a.load());
      if (saved) {
        this.data = {
          ...DEFAULT_SYNC_DATA,
          pendingChanges: [],
          journal: [],
          appliedPaths: [],
          ...saved
        };
        this.data.lastRevision = this.validRevision(this.data.lastRevision);
        this.data.seeded = this.data.seeded === true;
        this.data.pendingChanges = Array.isArray(this.data.pendingChanges) ? this.data.pendingChanges.filter((change) => this.validQueuedChange(change)) : [];
        this.data.appliedPaths = Array.isArray(this.data.appliedPaths) ? this.data.appliedPaths.filter((path) => this.validPath(path)) : [];
        this.data.journal = Array.isArray(this.data.journal) ? this.data.journal.filter((e) => this.validJournalEntry(e)).slice(-500) : [];
      }
    })();
    await this.loaded;
  }
  get seeded() {
    return this.data.seeded;
  }
  async markSeeded() {
    if (!this.data.seeded) {
      await this.save({ seeded: true });
    }
  }
  hasApplied(path) {
    return this.data.appliedPaths.includes(path);
  }
  async markApplied(newPath, oldPath) {
    const changed = [];
    if (newPath && !this.data.appliedPaths.includes(newPath)) {
      this.data.appliedPaths.push(newPath);
      changed.push(newPath);
    }
    if (oldPath) {
      const idx = this.data.appliedPaths.indexOf(oldPath);
      if (idx >= 0) {
        this.data.appliedPaths.splice(idx, 1);
        changed.push(oldPath);
      }
    }
    if (changed.length > 0) {
      await this.save({});
    }
  }
  /**
   * Mutations apply synchronously (so callers never see stale state) but the
   * backend write is serialized: concurrent queue writes, cursor updates,
   * seeded markers, journal updates, and recovery changes cannot overwrite one
   * another, and the latest snapshot always lands last.
   */
  async save(patch) {
    if (typeof patch.lastRevision === "number") {
      Object.assign(this.data, { ...patch, lastRevision: Math.max(this.data.lastRevision, patch.lastRevision) });
    } else {
      Object.assign(this.data, patch);
    }
    const snapshot = { ...this.data };
    const write = this.writeQueue.then(() => {
      var _a;
      return (_a = this.backend) == null ? void 0 : _a.save(snapshot);
    });
    this.writeQueue = write.catch(() => void 0);
    await write;
  }
  /**
   * Deliberate local resets (disconnect, rebuild, join, recovery) regress the
   * cursor and clear sync state on purpose; the monotonic guard must not fight
   * them. Identity fields passed in `patch` are kept.
   */
  async resetSyncState(patch) {
    Object.assign(this.data, patch);
    const snapshot = { ...this.data };
    const write = this.writeQueue.then(() => {
      var _a;
      return (_a = this.backend) == null ? void 0 : _a.save(snapshot);
    });
    this.writeQueue = write.catch(() => void 0);
    await write;
  }
  async setServerUrl(url) {
    await this.save({ serverUrl: url });
  }
  async setLastRevision(revision) {
    if (revision > this.data.lastRevision) {
      await this.save({ lastRevision: revision });
    }
  }
  async disconnect() {
    await this.resetSyncState({
      accountId: void 0,
      vaultId: void 0,
      vaultName: void 0,
      deviceId: void 0,
      deviceName: void 0,
      deviceToken: void 0,
      lastRevision: 0,
      pendingChanges: [],
      seeded: false,
      appliedPaths: [],
      journal: []
    });
  }
  validRevision(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  validPath(path) {
    if (typeof path !== "string") return false;
    try {
      normalizePath(path);
      return true;
    } catch (e) {
      return false;
    }
  }
  validJournalEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry;
    if (typeof e.operationId !== "string" || e.operationId.length === 0 || typeof e.revision !== "number" || !Number.isSafeInteger(e.revision) || e.revision < 0 || !Array.isArray(e.paths) || e.paths.length === 0 || !e.paths.every((p) => this.validPath(p))) {
      return false;
    }
    return true;
  }
  validQueuedChange(change) {
    if (!change || typeof change !== "object") return false;
    const item = change;
    if (typeof item.operationId !== "string" || typeof item.revision !== "number" || typeof item.deviceId !== "string" || typeof item.operation !== "string" || typeof item.baseRevision !== "number" || typeof item.timestamp !== "number" || typeof item.attempts !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 0 || !Number.isSafeInteger(item.baseRevision) || item.baseRevision < 0 || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !this.validPath(item.path)) {
      return false;
    }
    if (item.oldPath !== void 0 && !this.validPath(item.oldPath)) return false;
    if (item.causalParents !== void 0) {
      if (!Array.isArray(item.causalParents) || item.causalParents.some((p) => typeof p !== "string")) {
        return false;
      }
    }
    if (item.inFlight !== void 0 && typeof item.inFlight !== "boolean") return false;
    if (item.blocked !== void 0 && typeof item.blocked !== "boolean") return false;
    if (item.blockedReason !== void 0 && typeof item.blockedReason !== "string") return false;
    if (item.stagedFile !== void 0) {
      if (typeof item.stagedFile !== "string" || item.stagedFile.length === 0 || item.stagedFile.includes("/") || item.stagedFile === "." || item.stagedFile === "..") {
        return false;
      }
    }
    if (item.operation === "create" || item.operation === "update") {
      const hasPayload = typeof item.payload === "string" && isValidBase64(item.payload);
      const hasContent = item.content !== void 0 && isValidContentReference(item.content);
      if (!hasPayload && !hasContent) return false;
    }
    return item.operation === "create" || item.operation === "update" || item.operation === "delete" || item.operation === "rename";
  }
};

// src/sync/ChangeQueue.ts
function sameChange(a, b) {
  var _a, _b;
  if (a.operation !== b.operation) return false;
  if (a.path !== b.path || ((_a = a.oldPath) != null ? _a : void 0) !== ((_b = b.oldPath) != null ? _b : void 0)) return false;
  if (a.content && b.content) {
    return a.content.hash === b.content.hash && a.content.byteLength === b.content.byteLength && a.content.chunkCount === b.content.chunkCount;
  }
  if (!a.content && !b.content) return a.payload === b.payload;
  return false;
}
var ChangeQueue = class {
  constructor(state) {
    this.state = state;
  }
  get items() {
    return this.state.pendingChanges;
  }
  has(operationId) {
    return this.state.pendingChanges.some((c) => c.operationId === operationId);
  }
  hasPath(path) {
    return this.state.pendingChanges.some(
      (c) => c.path === path || c.oldPath === path
    );
  }
  /**
   * Ordered reducer: enqueueing a change for a path supersedes earlier
   * pending ops touching that path (except in-flight ones, which keep their
   * place in the causal chain) and records the surviving pending ops as
   * causal parents. Superseded ops are never committed, so their ids must
   * not appear in the parent set.
   */
  async enqueue(change) {
    var _a;
    const pending = this.state.pendingChanges;
    const touched = /* @__PURE__ */ new Set([change.path]);
    if (change.oldPath) touched.add(change.oldPath);
    if (change.operation === "rename") {
      const priorCreate = pending.find(
        (c) => c.operation === "create" && c.path === change.oldPath
      );
      if (priorCreate) {
        priorCreate.path = change.path;
        priorCreate.oldPath = void 0;
        await this.persist();
        return;
      }
      const priorRename = pending.find(
        (c) => c.operation === "rename" && c.path === change.oldPath
      );
      if (priorRename) {
        priorRename.path = change.path;
        await this.persist();
        return;
      }
    }
    const preserveRename = change.operation !== "rename" && pending.some((c) => c.operation === "rename" && c.path === change.path);
    const superseded = [];
    for (let i = pending.length - 1; i >= 0; i--) {
      const c = pending[i];
      const touchesPath = touched.has(c.path) || c.oldPath !== void 0 && touched.has(c.oldPath);
      const preserved = preserveRename && c.operation === "rename" && c.path === change.path;
      if (touchesPath && !preserved && c.inFlight !== true) {
        superseded.push(c);
        pending.splice(i, 1);
      }
    }
    const parents = /* @__PURE__ */ new Set();
    for (const c of pending) {
      for (const key of touched) {
        if (c.path === key || c.oldPath === key) parents.add(c.operationId);
      }
    }
    for (const c of superseded) {
      for (const p of (_a = c.causalParents) != null ? _a : []) parents.add(p);
    }
    parents.delete(change.operationId);
    const already = pending.some((c) => sameChange(c, change));
    if (!already) {
      pending.push({ ...change, attempts: 0, causalParents: [...parents], inFlight: false });
    }
    await this.persist();
  }
  async remove(operationId) {
    const pending = this.state.pendingChanges;
    const index = pending.findIndex((c) => c.operationId === operationId);
    if (index >= 0) {
      pending.splice(index, 1);
      await this.persist();
    }
  }
  /**
   * Removes an op that was never committed (permanently rejected) and scrubs
   * its id from the causal parents of survivors.
   */
  async removeDropped(operationId) {
    var _a;
    const pending = this.state.pendingChanges;
    const index = pending.findIndex((c) => c.operationId === operationId);
    if (index >= 0) pending.splice(index, 1);
    let changed = index >= 0;
    for (const c of pending) {
      if ((_a = c.causalParents) == null ? void 0 : _a.includes(operationId)) {
        c.causalParents = c.causalParents.filter((p) => p !== operationId);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }
  async refreshContent(operationId, content) {
    const item = this.state.pendingChanges.find((c) => c.operationId === operationId);
    if (item) {
      item.content = content;
      item.payload = void 0;
      await this.persist();
    }
  }
  async clear() {
    if (this.state.pendingChanges.length === 0) return;
    this.state.pendingChanges.splice(0, this.state.pendingChanges.length);
    await this.persist();
  }
  async markAttempted(operationId) {
    const item = this.state.pendingChanges.find((c) => c.operationId === operationId);
    if (item) {
      item.attempts += 1;
      await this.persist();
    }
  }
  get(operationId) {
    return this.state.pendingChanges.find((c) => c.operationId === operationId);
  }
  size() {
    return this.state.pendingChanges.length;
  }
  async persist() {
    await this.state.save({});
  }
};

// src/hashing/hash.ts
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/vault/VaultWatcher.ts
var DEBOUNCE_MS = 800;
var EXPECT_TTL_MS = 5e3;
var READ_ATTEMPTS = 3;
var READ_RETRY_MS = 300;
var VaultWatcher = class {
  constructor(ctx, ttlMs = EXPECT_TTL_MS) {
    this.ctx = ctx;
    this.ttlMs = ttlMs;
    this.pending = /* @__PURE__ */ new Map();
    this.expected = /* @__PURE__ */ new Map();
    this.flushTimer = null;
  }
  /**
   * Record the filesystem write the engine is about to perform so its echo
   * can be consumed without suppressing real local edits.
   */
  expect(path, kind, opts = {}) {
    let normalized;
    try {
      normalized = normalizePath(path);
    } catch (e) {
      return;
    }
    if (!this.isSyncable(normalized)) return;
    this.expected.set(normalized, {
      kind,
      sha: opts.sha,
      oldPath: opts.oldPath,
      until: Date.now() + this.ttlMs,
      matchesLeft: kind === "content" ? 3 : 2
    });
  }
  /** Clear all expectations (e.g. after a paused apply or on resume). */
  releaseAll() {
    this.expected.clear();
  }
  track(ev) {
    var _a;
    let path;
    try {
      path = normalizePath(ev.path);
      if (ev.kind === "rename") normalizePath((_a = ev.oldPath) != null ? _a : "");
    } catch (e) {
      return;
    }
    if (!this.isSyncable(path)) return;
    if (this.consumeIfExpected(ev, path)) return;
    const key = this.keyOf(ev);
    if (ev.kind === "delete") {
      const hadCreate = this.pending.has(`create:${path}`);
      const hadRename = this.pending.has(`rename:${path}`);
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      if (!hadRename) this.pending.delete(`rename:${path}`);
      if (hadCreate && !hadRename) {
        this.scheduleFlush();
        return;
      }
    } else if (ev.kind === "rename") {
      const { oldPath } = ev;
      const pendingCreate = this.pending.get(`create:${oldPath}`);
      const pendingRename = this.pending.get(`rename:${oldPath}`);
      if (pendingCreate) {
        this.pending.delete(`create:${oldPath}`);
        this.pending.delete(`modify:${oldPath}`);
        this.pending.delete(`delete:${oldPath}`);
        this.pending.delete(`rename:${oldPath}`);
        this.pending.delete(`create:${path}`);
        this.pending.delete(`modify:${path}`);
        this.pending.delete(`delete:${path}`);
        this.pending.set(`create:${path}`, { kind: "create", path });
        this.scheduleFlush();
        return;
      }
      if ((pendingRename == null ? void 0 : pendingRename.kind) === "rename") {
        this.pending.delete(`rename:${oldPath}`);
        this.pending.delete(`rename:${path}`);
        this.pending.set(`rename:${path}`, {
          kind: "rename",
          path,
          oldPath: pendingRename.oldPath
        });
        this.scheduleFlush();
        return;
      }
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      this.pending.delete(`delete:${path}`);
    } else {
      this.pending.delete(`delete:${path}`);
      if (ev.kind === "create") this.pending.delete(`rename:${path}`);
      this.pending.delete(ev.kind === "create" ? `modify:${path}` : `create:${path}`);
    }
    this.pending.set(key, ev);
    this.scheduleFlush();
  }
  async flush() {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const ev of events) {
      await this.emitOne(ev);
    }
  }
  consumeIfExpected(ev, path) {
    const exp = this.expected.get(path);
    if (!exp) return false;
    if (exp.until < Date.now()) {
      this.expected.delete(path);
      return false;
    }
    if (ev.kind === "delete") {
      if (exp.kind === "delete") {
        this.consume(path, exp);
        return true;
      }
      this.expected.delete(path);
      return false;
    }
    if (ev.kind === "rename") {
      if (exp.kind === "rename" && exp.oldPath === ev.oldPath) {
        this.consume(path, exp);
        return true;
      }
      this.expected.delete(path);
      return false;
    }
    if (exp.kind === "rename") {
      this.consume(path, exp);
      return true;
    }
    return false;
  }
  consume(path, exp) {
    exp.matchesLeft -= 1;
    if (exp.matchesLeft <= 0) this.expected.delete(path);
  }
  scheduleFlush() {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, DEBOUNCE_MS);
  }
  async emitOne(ev) {
    var _a, _b, _c;
    if (ev.kind === "delete") {
      const change2 = {
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: normalizePath(ev.path),
        operation: "delete",
        baseRevision: this.ctx.getBaseRevision(),
        timestamp: Date.now()
      };
      await this.ctx.onChange(change2);
      return;
    }
    if (ev.kind === "rename") {
      const change2 = {
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: normalizePath(ev.path),
        oldPath: normalizePath((_a = ev.oldPath) != null ? _a : ""),
        operation: "rename",
        baseRevision: this.ctx.getBaseRevision(),
        timestamp: Date.now()
      };
      await this.ctx.onChange(change2);
      return;
    }
    const bytes = await this.readWithRetry(ev.path);
    if (bytes === null) return;
    if (bytes.byteLength > MAX_FILE_BYTES) {
      (_c = (_b = this.ctx).onTooLarge) == null ? void 0 : _c.call(_b, ev.path, bytes.byteLength);
      return;
    }
    const data = new Uint8Array(bytes);
    const exp = this.expected.get(ev.path);
    if (exp && exp.until > Date.now() && exp.kind === "content") {
      const hash = await sha256Hex(data);
      if (exp.sha === void 0 || hash === exp.sha) {
        this.consume(ev.path, exp);
        return;
      }
      this.expected.delete(ev.path);
    }
    if (data.byteLength === 0) {
      const change2 = {
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: normalizePath(ev.path),
        operation: ev.kind === "modify" ? "update" : "create",
        baseRevision: this.ctx.getBaseRevision(),
        timestamp: Date.now(),
        payload: ""
      };
      await this.ctx.onChange(change2);
      return;
    }
    const operationId = this.newOperationId();
    if (this.ctx.stage) await this.ctx.stage(operationId, data);
    const change = {
      operationId,
      revision: 0,
      deviceId: "",
      path: normalizePath(ev.path),
      operation: ev.kind === "modify" ? "update" : "create",
      baseRevision: this.ctx.getBaseRevision(),
      timestamp: Date.now(),
      content: {
        hash: await sha256Hex(data),
        byteLength: data.byteLength,
        chunkCount: Math.max(1, Math.ceil(data.byteLength / CHUNK_BYTES))
      }
    };
    await this.ctx.onChange(change);
  }
  /**
   * Reads capture bytes with bounded retries. `null` (or a failed read that
   * never recovers) means the event is dropped — a genuine deletion returns
   * null from the adapter, and any later edit re-triggers a capture.
   */
  async readWithRetry(path) {
    let lastError = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        return await this.ctx.readBytes(path);
      } catch (e) {
        lastError = e;
        if (attempt < READ_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
        }
      }
    }
    console.warn(
      `SyncVault: dropped capture of "${path}" after ${READ_ATTEMPTS} failed reads`,
      lastError
    );
    return null;
  }
  keyOf(ev) {
    return ev.kind === "rename" ? `rename:${ev.path}` : `${ev.kind}:${ev.path}`;
  }
  isSyncable(path) {
    if (path === ".obsidian" || path.startsWith(".obsidian/")) return false;
    return true;
  }
  newOperationId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
};

// src/vault/ensureParentFolders.ts
async function ensureParentFolders(adapter, filePath) {
  const parts = filePath.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if (!await adapter.exists(current)) throw error;
    }
  }
}

// src/storage/Staging.ts
var VaultStaging = class {
  constructor(adapter, dir) {
    this.adapter = adapter;
    this.dir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  }
  path(operationId) {
    return `${this.dir}/${operationId}`;
  }
  async save(operationId, bytes) {
    await ensureParentFolders(this.adapter, this.path(operationId));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    );
    await this.adapter.writeBinary(this.path(operationId), buffer);
  }
  async load(operationId) {
    const p = this.path(operationId);
    if (!await this.adapter.exists(p)) return null;
    try {
      const data = await this.adapter.readBinary(p);
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch (e) {
      return null;
    }
  }
  async remove(operationId) {
    const p = this.path(operationId);
    if (await this.adapter.exists(p)) {
      await this.adapter.remove(p);
    }
  }
  async list() {
    try {
      return await this.adapter.list(this.dir);
    } catch (e) {
      return [];
    }
  }
};

// src/visual/VisualSync.ts
var VISUAL_NS = "syncvault-visual";
var NS_PREFIX = `${VISUAL_NS}/`;
var VisualSync = class {
  constructor(fs, onChange, onTooLarge) {
    this.fs = fs;
    this.onChange = onChange;
    this.onTooLarge = onTooLarge;
  }
  /** Map a config-relative path (e.g. `appearance.json`, `themes/X/theme.css`)
   * to its logical sync path, or null when it is out of scope. */
  translate(rel) {
    if (rel.trim() === "") return null;
    const clean = normalizePath(rel).replace(/^\/+/, "");
    if (clean === "") return null;
    if (clean === "appearance.json" || clean.startsWith("themes/")) {
      return NS_PREFIX + clean;
    }
    return null;
  }
  /** Inverse of translate(); null when `logical` is not a visual path. */
  static relPath(logical) {
    if (!logical.startsWith(NS_PREFIX)) return null;
    return logical.slice(NS_PREFIX.length);
  }
  /** Full scan of the visual scope, emitting a change per file. Runs at
   * startup, on manual refresh and on a low-frequency cadence so edits made
   * while the plugin was off or disabled still converge. */
  async scan() {
    await this.emitFile("appearance.json");
    const entries = await this.fs.list("themes").catch(() => []);
    for (const name of entries) {
      const folder = `themes/${name}`;
      const st = await this.fs.stat(folder).catch(() => null);
      if (!st) continue;
      if (st.kind === "folder") await this.walk(folder, 0);
      else await this.emitFile(folder);
    }
  }
  async walk(rel, depth) {
    if (depth > 8) return;
    const entries = await this.fs.list(rel).catch(() => []);
    for (const name of entries) {
      const child = `${rel}/${name}`;
      const st = await this.fs.stat(child).catch(() => null);
      if (!st) continue;
      if (st.kind === "folder") {
        await this.walk(child, depth + 1);
        continue;
      }
      await this.emitFile(child);
    }
  }
  async emitFile(rel) {
    const logical = this.translate(rel);
    if (!logical) return;
    const st = await this.fs.stat(rel).catch(() => null);
    if (!st || st.kind !== "file") return;
    if (st.size > MAX_FILE_BYTES) {
      this.onTooLarge(logical, st.size);
      return;
    }
    const bytes = await this.fs.readBytes(rel).catch(() => null);
    if (bytes === null) return;
    this.onChange({ logicalPath: logical, bytes });
  }
};

// src/storage/Journal.ts
var MAX_JOURNAL_ENTRIES = 500;
var Journal = class {
  constructor(state) {
    this.state = state;
  }
  proven(operationId) {
    return this.state.journal.some((e) => e.operationId === operationId);
  }
  async record(entry) {
    const journal = this.state.journal;
    const existing = journal.findIndex((e) => e.operationId === entry.operationId);
    if (existing >= 0) journal.splice(existing, 1);
    journal.push(entry);
    while (journal.length > MAX_JOURNAL_ENTRIES) journal.shift();
    await this.state.save({});
  }
};

// src/sync/SyncConnection.ts
var RETRY_BACKOFFS = [2e3, 5e3, 1e4, 3e4];
var FATAL_CLOSE_REASONS = /* @__PURE__ */ new Set([4001, 4400, 4401, 4402, 4403]);
var SyncConnection = class {
  constructor(params, callbacks) {
    this.params = params;
    this.callbacks = callbacks;
    this.ws = null;
    this.status = "idle";
    this.manualClose = false;
    this.retryIndex = 0;
    this.retryTimer = null;
    this.remoteChain = Promise.resolve();
    this.client = null;
    // WebSocket broadcasts arrive in server revision order on a single FIFO
    // socket, so an accepted reply always follows every earlier revision.
    this.advanceCursorOnAccept = true;
  }
  // Realtime transport: changes arrive live via the socket; nothing to poll.
  async pull() {
    return { currentRevision: 0, changes: [], resyncRequired: false };
  }
  get connected() {
    return this.status === "open";
  }
  connect() {
    if (this.status === "connecting" || this.status === "open") return;
    this.manualClose = false;
    this.setStatus("connecting");
    const url = this.wsUrl();
    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        if (typeof ws !== "undefined" && ws !== this.ws) return;
        this.retryIndex = 0;
        const p = this.params();
        this.send({
          type: "hello",
          accountId: p.accountId,
          vaultId: p.vaultId,
          deviceId: p.deviceId,
          token: p.token,
          lastRevision: p.getLastRevision(),
          capabilities: [CHUNK_CAPABILITY]
        });
      };
      ws.onmessage = (event) => this.dispatch(event);
      ws.onclose = (event) => {
        if (ws !== this.ws) return;
        this.handleClose(event);
      };
      ws.onerror = () => {
      };
    } catch (e) {
      this.setStatus("offline");
      this.scheduleRetry();
    }
  }
  disconnect() {
    var _a;
    this.manualClose = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      (_a = this.ws) == null ? void 0 : _a.close(1e3, "disconnect");
    } catch (e) {
    }
    this.ws = null;
    this.setStatus("idle");
  }
  sendChange(change, bytes) {
    if (change.content !== void 0 && bytes !== void 0) {
      this.uploadAndAnnounce(change, bytes);
      return true;
    }
    return this.send({ type: "change", change });
  }
  sendAck(revision) {
    return this.send({ type: "ack", revision });
  }
  async fetchContent(change) {
    if (change.content === void 0 || change.revision < 1) return null;
    return this.httpClient().downloadContent(
      this.params().accountId,
      this.params().vaultId,
      this.params().deviceId,
      this.params().token,
      change.revision,
      change.content
    );
  }
  async uploadAndAnnounce(change, bytes) {
    var _a, _b, _c, _d;
    const p = this.params();
    try {
      const result = await this.httpClient().uploadContent(
        p.accountId,
        p.vaultId,
        p.deviceId,
        p.token,
        change,
        bytes
      );
      if (result === null) {
        (_b = (_a = this.callbacks).onRetry) == null ? void 0 : _b.call(_a, change.operationId, "content upload failed");
        return;
      }
      if (result.status === "accepted") {
        this.send({ type: "change", change: { ...change, deviceId: p.deviceId } });
      }
    } catch (e) {
      (_d = (_c = this.callbacks).onRetry) == null ? void 0 : _d.call(_c, change.operationId, e.message);
      this.callbacks.onError(`upload failed: ${e.message}`);
    }
  }
  httpClient() {
    if (this.client === null) this.client = new SyncClient(this.params().serverUrl);
    return this.client;
  }
  wsUrl() {
    const p = this.params();
    const wsBase = p.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "");
    const q = new URLSearchParams({ accountId: p.accountId, deviceId: p.deviceId });
    return `${wsBase}/v1/vaults/${p.vaultId}/ws?${q.toString()}`;
  }
  send(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      return false;
    }
  }
  dispatch(event) {
    if (typeof event.data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (msg.type === "batch") {
      for (const item of msg.items) this.handle(item);
      return;
    }
    this.handle(msg);
  }
  handle(msg) {
    var _a, _b;
    switch (msg.type) {
      case "welcome":
        this.setStatus("open");
        (_b = (_a = this.callbacks).onAuthed) == null ? void 0 : _b.call(_a);
        this.chain(() => this.callbacks.onWelcome(msg.serverRevision, msg.resyncRequired));
        break;
      case "change":
        this.chain(() => this.callbacks.onRemoteChange(msg.change));
        break;
      case "accepted":
        this.chain(() => this.callbacks.onAccepted(msg.operationId, msg.revision));
        break;
      case "error":
        this.callbacks.onError(msg.message);
        break;
    }
  }
  chain(cb) {
    this.remoteChain = this.remoteChain.then(cb).catch(() => void 0);
  }
  handleClose(event) {
    if (this.manualClose) return;
    if (FATAL_CLOSE_REASONS.has(event.code)) {
      this.ws = null;
      this.setStatus("offline");
      this.callbacks.onError(`connection closed: ${event.reason || `code ${event.code}`}`);
      return;
    }
    this.ws = null;
    this.setStatus("offline");
    this.scheduleRetry();
  }
  scheduleRetry() {
    if (this.manualClose || this.retryTimer !== null) return;
    const delay = RETRY_BACKOFFS[Math.min(this.retryIndex, RETRY_BACKOFFS.length - 1)];
    this.retryIndex += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
  setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this.callbacks.onStatusChange(status);
    }
  }
};

// src/sync/HttpConnection.ts
function isApiError(e) {
  const maybe = e;
  return maybe instanceof Error && typeof maybe.status === "number" && typeof maybe.code === "string";
}
var HttpConnection = class {
  constructor(state, client, callbacks) {
    this.state = state;
    this.client = client;
    this.callbacks = callbacks;
    this.connectedFlag = false;
    // HTTP knows nothing about broadcast order: a push accept replies with the
    // server's global revision, which may skip interleaved remote changes. The
    // cursor advances only when those changes are actually applied.
    this.advanceCursorOnAccept = false;
  }
  get connected() {
    return this.connectedFlag && this.state.connected;
  }
  connect() {
    this.connectedFlag = true;
    this.callbacks.onStatusChange("open");
  }
  disconnect() {
    this.connectedFlag = false;
    this.callbacks.onStatusChange("idle");
  }
  async pull(since) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    try {
      const r = await this.client.pullChanges(
        (_a = this.state.accountId) != null ? _a : "",
        (_b = this.state.vaultId) != null ? _b : "",
        (_c = this.state.deviceId) != null ? _c : "",
        (_d = this.state.deviceToken) != null ? _d : "",
        since
      );
      if (r.resyncRequired) {
        (_f = (_e = this.callbacks).onResyncRequired) == null ? void 0 : _f.call(_e);
      }
      (_h = (_g = this.callbacks).onAuthed) == null ? void 0 : _h.call(_g);
      return { currentRevision: r.currentRevision, changes: r.changes, resyncRequired: r.resyncRequired };
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        (_j = (_i = this.callbacks).onAuthFailure) == null ? void 0 : _j.call(_i, "authentication expired; reconnect the vault");
      } else if (isApiError(e) && e.code === "CLIENT_UPGRADE_REQUIRED") {
        (_l = (_k = this.callbacks).onError) == null ? void 0 : _l.call(
          _k,
          "this vault uses SyncVault v2 content; update the plugin"
        );
      }
      throw e;
    }
  }
  sendChange(change, bytes) {
    const p = this.params();
    void this.push(change, bytes, p);
    return true;
  }
  sendAck(revision) {
    const p = this.params();
    void this.client.sendAck(p.accountId, p.vaultId, p.deviceId, p.token, revision).catch(() => void 0);
    return true;
  }
  async fetchContent(change) {
    var _a, _b, _c, _d;
    if (change.content === void 0 || change.revision < 1) return null;
    const p = this.params();
    try {
      return await this.client.downloadContent(
        p.accountId,
        p.vaultId,
        p.deviceId,
        p.token,
        change.revision,
        change.content
      );
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        (_b = (_a = this.callbacks).onAuthFailure) == null ? void 0 : _b.call(_a, "authentication expired; reconnect the vault");
        return null;
      }
      (_d = (_c = this.callbacks).onError) == null ? void 0 : _d.call(_c, `content download failed: ${e.message}`);
      return null;
    }
  }
  async push(change, bytes, p) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r;
    try {
      const result = change.content !== void 0 && bytes !== void 0 ? await this.client.uploadContent(p.accountId, p.vaultId, p.deviceId, p.token, change, bytes) : await this.client.pushChange(p.accountId, p.vaultId, p.deviceId, p.token, change);
      if (result === null) {
        (_b = (_a = this.callbacks).onRetry) == null ? void 0 : _b.call(_a, change.operationId, "content upload failed");
        return;
      }
      (_d = (_c = this.callbacks).onAuthed) == null ? void 0 : _d.call(_c);
      this.callbacks.onAccepted(change.operationId, result.revision);
    } catch (e) {
      if (isApiError(e) && e.status === 401) {
        (_f = (_e = this.callbacks).onRetry) == null ? void 0 : _f.call(_e, change.operationId, e.message);
        (_h = (_g = this.callbacks).onAuthFailure) == null ? void 0 : _h.call(_g, "authentication expired; reconnect the vault");
        return;
      }
      if (isApiError(e) && e.code === "RESYNC_REQUIRED") {
        (_j = (_i = this.callbacks).onResyncRequired) == null ? void 0 : _j.call(_i);
        (_l = (_k = this.callbacks).onError) == null ? void 0 : _l.call(_k, e.message);
        return;
      }
      if (isApiError(e) && e.status >= 400 && e.status < 500) {
        (_n = (_m = this.callbacks).onRejected) == null ? void 0 : _n.call(_m, change.operationId, e.code, e.message);
        return;
      }
      (_p = (_o = this.callbacks).onRetry) == null ? void 0 : _p.call(_o, change.operationId, e.message);
      (_r = (_q = this.callbacks).onError) == null ? void 0 : _r.call(_q, `push failed: ${e.message}`);
    }
  }
  params() {
    var _a, _b, _c, _d;
    return {
      accountId: (_a = this.state.accountId) != null ? _a : "",
      vaultId: (_b = this.state.vaultId) != null ? _b : "",
      deviceId: (_c = this.state.deviceId) != null ? _c : "",
      token: (_d = this.state.deviceToken) != null ? _d : ""
    };
  }
};

// src/sync/SyncEngine.ts
var ACK_TIMEOUT_MS = 3e4;
var CHUNKED_ACK_TIMEOUT_MS = 5 * 6e4;
var DEFAULT_POLL_INTERVAL_MS = 4e3;
var CONVERGE_ROUND_CAP = 10;
var APPLY_STRIKE_WINDOW_MS = 4e3;
var MAX_APPLY_FAILURES = 3;
var MAX_INLINE_BYTES2 = 1024 * 1024;
var SyncEngine = class {
  constructor(state, queue, watcher, vault, onStatus, onNotice, options = {}) {
    this.state = state;
    this.queue = queue;
    this.watcher = watcher;
    this.vault = vault;
    this.onStatus = onStatus;
    this.onNotice = onNotice;
    this.statusValue = "idle";
    this.syncInFlight = false;
    this.pendingAcks = /* @__PURE__ */ new Map();
    this.ackTarget = 0;
    this.pollTimer = null;
    this.polling = false;
    this.paused = false;
    this.consecutiveAuthFailures = 0;
    this.resyncBlocked = false;
    /** Bumped by every stop(); in-flight sync work checks it before mutating
     * state, so an old run can never corrupt a newer one after restart/reset. */
    this.generation = 0;
    this.syncSoonTimer = null;
    this.applyFailureCount = 0;
    this.lastApplyFailureAt = 0;
    var _a, _b, _c, _d;
    this.pollIntervalMs = (_a = options.pollIntervalMs) != null ? _a : DEFAULT_POLL_INTERVAL_MS;
    this.scanner = options.scanner;
    this.staging = options.staging;
    this.applyStrikeWindowMs = (_b = options.applyStrikeWindowMs) != null ? _b : APPLY_STRIKE_WINDOW_MS;
    this.journal = new Journal(state);
    const handlers = {
      onWelcome: (serverRevision, resyncRequired) => this.handleWelcome(serverRevision, resyncRequired),
      onRemoteChange: (change) => this.applyRemoteChange(change),
      onAccepted: (operationId, revision) => this.settleAck(operationId, { status: "accepted", revision }),
      onRejected: (operationId, code, message) => this.handleRejected(operationId, code, message),
      onAuthFailure: (message) => this.handleAuthFailure(message),
      onAuthed: () => {
        this.consecutiveAuthFailures = 0;
      },
      onRetry: (operationId, message) => this.handleRetry(operationId, message),
      onResyncRequired: (message) => this.handleResyncRequired(message),
      onError: (message) => this.onNotice(`SyncVault: ${message}`, 6e3),
      onStatusChange: (status) => this.handleConnectionStatus(status)
    };
    this.connection = (_d = (_c = options.connectionFactory) == null ? void 0 : _c.call(options, handlers)) != null ? _d : options.client ? new HttpConnection(state, options.client, handlers) : new SyncConnection(
      () => {
        var _a2, _b2, _c2, _d2;
        return {
          serverUrl: this.state.serverUrl,
          accountId: (_a2 = this.state.accountId) != null ? _a2 : "",
          vaultId: (_b2 = this.state.vaultId) != null ? _b2 : "",
          deviceId: (_c2 = this.state.deviceId) != null ? _c2 : "",
          token: (_d2 = this.state.deviceToken) != null ? _d2 : "",
          getLastRevision: () => this.state.lastRevision
        };
      },
      handlers
    );
  }
  get status() {
    return this.statusValue;
  }
  get pendingCount() {
    return this.queue.size();
  }
  get isPaused() {
    return this.paused;
  }
  async start() {
    if (!this.state.connected) return;
    this.generation += 1;
    this.connection.connect();
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    }
    await this.pollOnce();
    await this.reconcileStaging();
    await this.migrateLegacyPayloads();
  }
  stop() {
    this.generation += 1;
    this.connection.disconnect();
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.syncSoonTimer !== null) {
      clearTimeout(this.syncSoonTimer);
      this.syncSoonTimer = null;
    }
    this.clearPendingAcks();
    this.syncInFlight = false;
    this.polling = false;
    this.paused = false;
    this.applyFailureCount = 0;
    this.setStatus("idle");
  }
  async resetForRebuild() {
    this.stop();
    this.ackTarget = 0;
    this.resyncBlocked = false;
    await this.queue.clear();
  }
  /**
   * Resume after a pause (or simply trigger a sync round): clears the paused
   * flag, (re)connects and runs one poll immediately.
   */
  async resume() {
    this.paused = false;
    this.resyncBlocked = false;
    this.applyFailureCount = 0;
    this.lastApplyFailureAt = 0;
    if (this.statusValue === "paused") {
      this.setStatus("syncing");
    }
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    }
    await this.syncNow();
  }
  async syncNow() {
    if (!this.state.connected) {
      this.onNotice("SyncVault: not configured", 4e3);
      return;
    }
    this.paused = false;
    this.connection.connect();
    await this.pollOnce();
  }
  async pollOnce() {
    if (this.paused) return;
    if (!this.state.connected) return;
    if (this.polling) return;
    if (!this.connection.connected) return;
    const gen = this.generation;
    this.polling = true;
    try {
      const capped = await this.converge(gen);
      if (gen !== this.generation) return;
      if (this.paused) return;
      if (capped) {
        this.setStatus("syncing");
        setTimeout(() => void this.pollOnce(), 0);
      } else if (this.state.pendingChanges.length === 0) {
        this.setStatus(this.connection.connected ? "synced" : "offline");
      }
    } catch (e) {
      if (gen === this.generation) this.setStatus("offline");
    } finally {
      this.polling = false;
    }
  }
  /**
   * Convergence loop: pull → apply → flush queue → pull again until both the
   * remote stream and this device's uploads are consumed (10-round cap).
   * Self-pushed and interleaved revisions are applied in revision order; only
   * applied revisions advance the cursor.
   */
  async converge(gen) {
    for (let round = 0; round < CONVERGE_ROUND_CAP; round++) {
      if (gen !== this.generation) return false;
      const result = await this.connection.pull(this.state.lastRevision);
      if (gen !== this.generation) return false;
      if (result.resyncRequired) {
        this.handleResyncRequired(
          "local history is older than the server retention window. Resync is not supported yet."
        );
        return false;
      }
      if (result.changes.length > 0) this.setStatus("downloading");
      for (const change of result.changes) {
        await this.applyRemoteChange(change);
        if (gen !== this.generation) return false;
        if (this.paused) return false;
      }
      await this.maybeSeed();
      await this.flushQueue();
      if (this.paused) return false;
      if (result.changes.length === 0 && (this.state.pendingChanges.length === 0 || this.resyncBlocked)) {
        return false;
      }
    }
    return this.state.pendingChanges.length > 0;
  }
  handleConnectionStatus(status) {
    if (status === "offline") {
      this.setStatus("offline");
    } else if (status === "open" && this.statusValue === "offline") {
      this.setStatus("synced");
    }
  }
  handleAuthFailure(message) {
    this.consecutiveAuthFailures += 1;
    if (this.consecutiveAuthFailures < 3) {
      this.onNotice(
        `SyncVault: ${message} (${this.consecutiveAuthFailures}/3) \u2014 retrying.`,
        6e3
      );
      return;
    }
    this.connection.disconnect();
    this.clearPendingAcks();
    this.paused = true;
    this.setStatus("paused");
    this.onNotice(
      `SyncVault: sync paused \u2014 ${message}. Reconnect the vault: Settings \u2192 Reconnect vault.`,
      1e4
    );
  }
  /** Called after a successful reconnect: resume polling with a clean slate. */
  authRecovered() {
    this.consecutiveAuthFailures = 0;
    return this.resume();
  }
  handleResyncRequired(message) {
    this.resyncBlocked = true;
    this.clearPendingAcks();
    this.onNotice(
      `SyncVault: ${message != null ? message : "local history is older than the server retention window. Resync is not supported yet."}`,
      1e4
    );
    this.setStatus("paused");
  }
  async handleWelcome(serverRevision, resyncRequired) {
    if (resyncRequired) {
      this.handleResyncRequired();
      return;
    }
    this.consecutiveAuthFailures = 0;
    this.setStatus("synced");
    if (!this.paused) await this.flushQueue();
  }
  async applyRemoteChange(change) {
    const gen = this.generation;
    if (this.statusValue === "idle") this.setStatus("downloading");
    const paths = change.oldPath ? [change.path, change.oldPath] : [change.path];
    try {
      await this.watcher.flush();
      if (gen !== this.generation) return;
      if (this.journal.proven(change.operationId)) {
      } else if (this.queueTouchesPath(change)) {
      } else {
        await this.apply(change);
        if (gen !== this.generation) return;
      }
      await this.state.markApplied(change.path, change.oldPath);
      await this.journal.record({
        operationId: change.operationId,
        revision: change.revision,
        paths
      });
    } catch (e) {
      const now = Date.now();
      if (now - this.lastApplyFailureAt >= this.applyStrikeWindowMs) {
        this.applyFailureCount += 1;
      }
      this.lastApplyFailureAt = now;
      const message = e.message;
      if (this.applyFailureCount < MAX_APPLY_FAILURES) {
        this.setStatus("syncing");
        this.onNotice(
          `SyncVault: could not apply "${change.path}": ${message} \u2014 retrying (${this.applyFailureCount}/${MAX_APPLY_FAILURES}).`,
          6e3
        );
        return;
      }
      this.paused = true;
      this.setStatus("paused");
      this.onNotice(
        `SyncVault: sync paused \u2014 could not apply "${change.path}": ${message}. Fix the issue, then resume sync (Settings \u2192 Resume).`,
        1e4
      );
      return;
    }
    if (change.revision > this.ackTarget) {
      this.ackTarget = change.revision;
      await this.state.setLastRevision(change.revision);
      this.connection.sendAck(change.revision);
    }
    this.applyFailureCount = 0;
    if (this.queue.size() === 0) this.setStatus("synced");
  }
  /**
   * First-run seed: enqueue every local file as a "create" so a device's
   * existing vault reaches the server. Pulled paths (marked applied) are
   * skipped, preventing duplicate re-uploads on devices that just joined.
   */
  async maybeSeed() {
    if (this.state.seeded) return;
    if (!this.scanner) {
      await this.state.markSeeded();
      return;
    }
    let files;
    try {
      files = await this.scanner.listFiles();
    } catch (e) {
      return;
    }
    for (const f of files) {
      if (!this.syncablePath(f.path)) continue;
      if (this.state.hasApplied(f.path)) continue;
      if (f.size > MAX_FILE_BYTES) continue;
      let content;
      if (this.scanner.readBytes) {
        let bytes;
        try {
          bytes = await this.scanner.readBytes(f.path);
        } catch (e) {
          return;
        }
        if (bytes === null) continue;
        if (bytes.byteLength > MAX_FILE_BYTES) continue;
        if (bytes.byteLength === 0) {
          await this.queue.enqueue({
            operationId: this.newOperationId(),
            revision: 0,
            deviceId: "",
            path: f.path,
            operation: "create",
            baseRevision: this.state.lastRevision,
            timestamp: Date.now(),
            payload: ""
          });
          continue;
        }
        const data = new Uint8Array(bytes);
        content = await this.contentFor(data);
        if (this.staging) {
          const operationId = this.newOperationId();
          await this.staging.save(operationId, data);
          await this.queue.enqueue({
            operationId,
            revision: 0,
            deviceId: "",
            path: f.path,
            operation: "create",
            baseRevision: this.state.lastRevision,
            timestamp: Date.now(),
            content,
            stagedFile: operationId
          });
          continue;
        }
      }
      await this.queue.enqueue({
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: f.path,
        operation: "create",
        baseRevision: this.state.lastRevision,
        timestamp: Date.now(),
        content
      });
    }
    await this.state.markSeeded();
  }
  /**
   * Queue path for watcher-captured changes. Content changes reference their
   * staged byte snapshot so the flush cannot read a file that changed again.
   */
  async enqueueLocal(change) {
    if (change.content && change.operationId) {
      await this.queue.enqueue({ ...change, stagedFile: change.operationId });
    } else {
      await this.queue.enqueue(change);
    }
    this.scheduleImmediateSync();
  }
  /**
   * A short-coalesced prompt sync after local captures. Never runs while a
   * poll or flush is already active (they pick the change up themselves).
   */
  scheduleImmediateSync() {
    if (this.paused || !this.state.connected || !this.connection.connected) return;
    if (this.syncSoonTimer !== null) return;
    this.syncSoonTimer = setTimeout(() => {
      this.syncSoonTimer = null;
      if (this.polling || this.syncInFlight || this.paused) return;
      if (!this.connection.connected) return;
      void this.pollOnce();
    }, 50);
  }
  /**
   * Delete staged snapshots that survived a crash between staging and
   * enqueueing (or belong to a discarded queue); queued items retain theirs.
   */
  async reconcileStaging() {
    if (!this.staging) return;
    const queued = new Set(this.queue.items.map((item) => item.stagedFile).filter((id) => !!id));
    for (const operationId of await this.staging.list()) {
      if (!queued.has(operationId)) await this.staging.remove(operationId);
    }
  }
  async contentFor(bytes) {
    const hash = await sha256Hex(bytes);
    return {
      hash,
      byteLength: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES))
    };
  }
  syncablePath(path) {
    try {
      const normalized = normalizePath(path);
      if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) return false;
      return true;
    } catch (e) {
      return false;
    }
  }
  newOperationId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  /**
   * True when a pending local operation (still queued for upload) touches the
   * same vault path(s) as an incoming remote change. The local edit is newer
   * than the remote revision and wins; see applyRemoteChange.
   */
  queueTouchesPath(change) {
    if (this.queue.hasPath(change.path)) return true;
    if (change.oldPath !== void 0 && this.queue.hasPath(change.oldPath)) return true;
    return false;
  }
  async apply(change) {
    if (this.journal.proven(change.operationId)) return;
    switch (change.operation) {
      case "create":
      case "update": {
        let sha;
        let data;
        if (change.content !== void 0) {
          if (!isValidContentReference(change.content)) throw new Error("invalid content descriptor");
          const bytes = await this.connection.fetchContent(change);
          if (bytes === null) throw new Error("content could not be downloaded or verified");
          sha = change.content.hash;
          data = bytes;
        } else {
          if (typeof change.payload !== "string") throw new Error("missing payload");
          if (!isValidBase64(change.payload)) throw new Error("invalid payload");
          data = fromBase64(change.payload);
          sha = await sha256Hex(data);
        }
        await this.removeBlockingAncestors(normalizePath(change.path));
        const path = normalizePath(change.path);
        this.watcher.expect(path, "content", { sha });
        await this.vault.write(path, data);
        return;
      }
      case "delete": {
        const path = normalizePath(change.path);
        const kind = await this.vault.stat(path);
        if (kind === null) return;
        this.watcher.expect(path, "delete");
        await this.vault.remove(path);
        return;
      }
      case "rename": {
        if (!change.oldPath) throw new Error("rename missing oldPath");
        await this.applyRename(normalizePath(change.oldPath), normalizePath(change.path), change);
        return;
      }
    }
  }
  /**
   * Idempotent rename application:
   * - journal-proven operations are already complete (lost-ACK redelivery).
   * - source missing + destination present: either we renamed it, or the user
   *   did — either way the goal state holds; journal it and move on.
   * - both missing: genuinely ambiguous; pausing (never ACKing) is safer than
   *   guessing.
   * - occupied destination: removed — the incoming revision wins.
   * - case-only rename: two-step through a unique temp name in the same folder
   *   because case-insensitive filesystems treat old==new.
   */
  async applyRename(oldPath, newPath, change) {
    if (this.journal.proven(change.operationId)) return;
    const oldKind = await this.vault.stat(oldPath);
    const newKind = await this.vault.stat(newPath);
    const caseOnly = oldPath !== newPath && oldPath.toLowerCase() === newPath.toLowerCase();
    if (oldKind === null && newKind !== null) {
      await this.journal.record({
        operationId: change.operationId,
        revision: change.revision,
        paths: [newPath, oldPath]
      });
      return;
    }
    if (oldKind === null && newKind === null) {
      throw new Error("rename target and source are both missing");
    }
    if (newKind === "folder") {
      throw new Error("rename target is a folder");
    }
    if (newKind === "file" && !caseOnly) {
      this.watcher.expect(newPath, "delete");
      await this.vault.remove(newPath);
    }
    if (caseOnly) {
      const temp = this.caseRenameTemp(oldPath);
      this.watcher.expect(temp, "rename", { oldPath });
      await this.vault.rename(oldPath, temp);
      this.watcher.expect(newPath, "rename", { oldPath: temp });
      await this.vault.rename(temp, newPath);
    } else {
      this.watcher.expect(newPath, "rename", { oldPath });
      await this.vault.rename(oldPath, newPath);
    }
  }
  /**
   * A remote write must never silently fail because a file sits where a
   * folder belongs: remove the blocking file, then let the write create the
   * folders. The incoming revision wins; no backup copy is made.
   */
  async removeBlockingAncestors(path) {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      const kind = await this.vault.stat(current);
      if (kind === null) break;
      if (kind === "file") {
        this.watcher.expect(current, "delete");
        await this.vault.remove(current);
        return;
      }
    }
  }
  /** Queue a local file for upload (used by the visual-appearance mirror).
   * Small files travel as inline base64 payloads like captured changes;
   * larger ones are staged and sent via their content descriptor. Every size
   * is queued at its original logical path. */
  async enqueueVisualChange(path, bytes) {
    if (bytes.byteLength === 0 || bytes.byteLength <= MAX_INLINE_BYTES2) {
      await this.enqueueLocal({
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path,
        operation: "create",
        baseRevision: this.state.lastRevision,
        timestamp: Date.now(),
        payload: bytes.byteLength === 0 ? "" : toBase64(bytes)
      });
      return;
    }
    const operationId = this.newOperationId();
    if (this.staging) await this.staging.save(operationId, bytes);
    await this.enqueueLocal({
      operationId,
      revision: 0,
      deviceId: "",
      path,
      operation: "create",
      baseRevision: this.state.lastRevision,
      timestamp: Date.now(),
      content: await this.contentFor(bytes),
      stagedFile: operationId
    });
  }
  /** Number of local files the initial seed would upload (for recovery safety
   * checks). Returns -1 if the scanner is unavailable or the scan failed. */
  async countSyncableFiles() {
    if (!this.scanner) return -1;
    try {
      const files = await this.scanner.listFiles();
      let count = 0;
      for (const f of files) {
        if (!this.syncablePath(f.path)) continue;
        if (f.size > MAX_FILE_BYTES || f.size <= 0) continue;
        count += 1;
      }
      return count;
    } catch (e) {
      return -1;
    }
  }
  caseRenameTemp(path) {
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `${dir}.${stem}-syncvault-${this.newOperationId().slice(0, 8)}${ext}`;
  }
  /**
   * v0.1.3-era devices carried small files as base64 payloads inside the
   * queue (data.json). Move them to durable staging once: drop the payload,
   * keep a content descriptor + stagedFile reference.
   */
  async migrateLegacyPayloads() {
    if (!this.staging) return;
    let changed = false;
    for (const item of this.queue.items) {
      if (item.stagedFile || typeof item.payload !== "string" || item.payload.length === 0) {
        continue;
      }
      try {
        const bytes = fromBase64(item.payload);
        await this.staging.save(item.operationId, bytes);
        item.content = await this.contentFor(bytes);
        item.stagedFile = item.operationId;
        item.payload = void 0;
        changed = true;
      } catch (e) {
      }
    }
    if (changed) await this.state.save({});
  }
  async flushQueue() {
    var _a, _b, _c;
    if (!this.connection.connected) return;
    if (this.resyncBlocked) return;
    if (this.syncInFlight) return;
    const gen = this.generation;
    this.syncInFlight = true;
    this.setStatus(this.queue.size() > 0 ? "uploading" : this.statusValue);
    try {
      for (const item of [...this.queue.items]) {
        if (!this.connection.connected) break;
        let bytes;
        let inlinePayload;
        if (item.content) {
          if (item.stagedFile && this.staging) {
            bytes = (_a = await this.staging.load(item.stagedFile)) != null ? _a : void 0;
          }
          if (!bytes) {
            const read = await this.vault.readFile(item.path);
            if (read === null) {
              await this.queue.remove(item.operationId);
              if (item.stagedFile) await ((_b = this.staging) == null ? void 0 : _b.remove(item.stagedFile));
              continue;
            }
            bytes = read;
            const hash = await sha256Hex(bytes);
            if (hash !== item.content.hash) {
              const fresh = await this.contentFor(bytes);
              await this.queue.refreshContent(item.operationId, fresh);
              item.content = fresh;
            }
          }
          if (bytes.byteLength <= MAX_INLINE_BYTES2) {
            inlinePayload = toBase64(bytes);
          }
        }
        if (gen !== this.generation) break;
        const result = await this.sendAndWait(item, inlinePayload !== void 0 ? void 0 : bytes, inlinePayload);
        if (gen !== this.generation) break;
        if (result === null) break;
        if (result.status === "retry") break;
        if (result.status === "rejected") {
          continue;
        }
        if (result.status === "accepted") {
          await this.recordAcceptedLocal(item, result.revision);
          await this.queue.remove(item.operationId);
          if (item.stagedFile) await ((_c = this.staging) == null ? void 0 : _c.remove(item.stagedFile));
          if (this.connection.advanceCursorOnAccept) {
            await this.state.setLastRevision(result.revision);
          }
        }
      }
    } finally {
      this.syncInFlight = false;
      if (this.connection.connected) {
        if (this.paused) {
          this.setStatus("paused");
        } else if (this.resyncBlocked) {
          this.setStatus("paused");
        } else {
          this.setStatus(this.queue.size() > 0 ? "syncing" : "synced");
        }
      }
    }
  }
  /**
   * An accepted local push is recorded in the journal before its queue entry
   * is dropped. The HTTP transport never advances the cursor on accept, so
   * the next pull redelivers the push as an echo; the journal entry is what
   * keeps that echo from rewriting the file over newer local edits.
   */
  async recordAcceptedLocal(item, revision) {
    await this.journal.record({
      operationId: item.operationId,
      revision,
      paths: item.oldPath ? [item.path, item.oldPath] : [item.path]
    });
  }
  sendAndWait(item, bytes, inlinePayload) {
    if (!this.connection.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      var _a;
      const timeoutMs = bytes && bytes.byteLength > 0 ? CHUNKED_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }, timeoutMs);
      this.pendingAcks.set(item.operationId, { resolve, timer });
      item.inFlight = true;
      const wireChange = {
        ...item,
        deviceId: (_a = this.state.deviceId) != null ? _a : "",
        ...inlinePayload !== void 0 ? { content: void 0, payload: inlinePayload } : {}
      };
      if (!this.connection.sendChange(wireChange, bytes)) {
        clearTimeout(timer);
        this.pendingAcks.delete(item.operationId);
        item.inFlight = false;
        resolve(null);
      }
    });
  }
  settleAck(operationId, result) {
    const pending = this.pendingAcks.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(operationId);
    const item = this.queue.get(operationId);
    if (item) item.inFlight = false;
    pending.resolve(result);
  }
  clearPendingAcks() {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ status: "retry" });
    }
    this.pendingAcks.clear();
  }
  handleRetry(operationId, message) {
    this.settleAck(operationId, { status: "retry" });
    this.onNotice(`SyncVault: upload will retry: ${message}`, 6e3);
  }
  handleRejected(operationId, code, message) {
    var _a;
    const pending = this.pendingAcks.get(operationId);
    if (pending) this.settleAck(operationId, { status: "rejected" });
    const item = this.queue.get(operationId);
    if (item) {
      void this.queue.removeDropped(operationId);
      if (item.stagedFile) void ((_a = this.staging) == null ? void 0 : _a.remove(item.stagedFile));
      this.onNotice(`SyncVault: skipped "${item.path}": ${message}`, 6e3);
    }
  }
  setStatus(status) {
    if (this.statusValue !== status) {
      this.statusValue = status;
      this.onStatus(status);
    }
  }
};

// src/main.ts
var STAGING_DIR = "plugins/syncvault/staging";
function configRel(path) {
  if (path === ".obsidian") return "";
  if (path.startsWith(".obsidian/")) return path.slice(".obsidian/".length);
  return null;
}
function configResolve(configDir, rel) {
  return rel === "" ? configDir : `${configDir}/${rel}`;
}
var STATUS_ICONS = {
  idle: "SyncVault: \u2713",
  syncing: "SyncVault: \u21BB Syncing",
  downloading: "SyncVault: \u2193 Downloading",
  uploading: "SyncVault: \u2191 Uploading",
  offline: "SyncVault: \u2715 Offline",
  synced: "SyncVault: \u2713 Synced",
  paused: "SyncVault: \u23F8 Paused"
};
var SyncVaultPlugin = class extends import_obsidian6.Plugin {
  constructor() {
    super(...arguments);
    this.state = new SyncState({
      load: () => this.loadData(),
      save: (data) => this.saveData(data)
    });
    this.client = new SyncClient("https://syncvault.hangyakuzero.workers.dev");
    this.auth = new AuthManager(this.state, this.client);
    this.queue = new ChangeQueue(this.state);
    this.staging = new VaultStaging(
      {
        exists: (path) => this.app.vault.adapter.exists(path),
        mkdir: (path) => this.app.vault.adapter.mkdir(path),
        writeBinary: (path, data) => this.app.vault.adapter.writeBinary(path, data),
        readBinary: (path) => this.app.vault.adapter.readBinary(path),
        remove: (path) => this.app.vault.adapter.remove(path),
        list: async (folder) => {
          const listing = await this.app.vault.adapter.list(folder);
          const entries = Array.isArray(listing.files) ? listing.files : [];
          return entries.map((entry) => {
            var _a;
            const name = typeof entry === "string" ? entry : (_a = entry.name) != null ? _a : String(entry);
            return name.startsWith(folder) ? name.slice(folder.length + 1) : name;
          });
        }
      },
      `${this.app.vault.configDir}/${STAGING_DIR}`
    );
    this.watcher = new VaultWatcher({
      readBytes: async (path) => {
        const vr = VisualSync.relPath(path);
        const real = vr !== null ? configResolve(this.app.vault.configDir, vr) : path;
        const st = await this.app.vault.adapter.stat(real).catch(() => null);
        if (st === null) return null;
        if (st.type === "folder") return null;
        return await this.app.vault.adapter.readBinary(real);
      },
      getBaseRevision: () => this.state.lastRevision,
      stage: (operationId, bytes) => this.staging.save(operationId, bytes),
      onChange: (change) => this.engine.enqueueLocal(change),
      onTooLarge: (path, size) => {
        new import_obsidian6.Notice(
          `SyncVault: "${path}" (${(size / 1024 / 1024).toFixed(1)} MB) exceeds the 16 MB sync limit and was not synced`,
          8e3
        );
      }
    });
    /** Mirrors `.obsidian/appearance.json` + installed themes via the
     * `syncvault-visual/…` logical namespace (same change stream, no new
     * protocol). */
    this.visual = new VisualSync(
      {
        stat: async (rel) => {
          var _a;
          const st = await this.app.vault.adapter.stat(configResolve(this.app.vault.configDir, rel)).catch(() => null);
          return st ? { kind: st.type === "folder" ? "folder" : "file", size: (_a = st.size) != null ? _a : 0 } : null;
        },
        readBytes: async (rel) => {
          try {
            return new Uint8Array(await this.app.vault.adapter.readBinary(configResolve(this.app.vault.configDir, rel)));
          } catch (e) {
            return null;
          }
        },
        list: async (rel) => {
          const listing = await this.app.vault.adapter.list(configResolve(this.app.vault.configDir, rel)).catch(() => null);
          if (!listing) return [];
          const entries = Array.isArray(listing.files) ? listing.files : [];
          return entries.map((entry) => {
            var _a;
            const name = typeof entry === "string" ? entry : (_a = entry.name) != null ? _a : String(entry);
            return name.startsWith(rel) ? name.slice(rel.length + 1) : name;
          });
        }
      },
      (change) => {
        void this.engine.enqueueVisualChange(change.logicalPath, change.bytes);
      },
      (path, size) => {
        new import_obsidian6.Notice(
          `SyncVault: "${path}" (${(size / 1024 / 1024).toFixed(1)} MB) exceeds the 16 MB sync limit and was not synced`,
          8e3
        );
      }
    );
    this.engine = new SyncEngine(
      this.state,
      this.queue,
      this.watcher,
      {
        write: async (path, data) => {
          const vr = VisualSync.relPath(path);
          if (vr !== null) {
            if (this.state.visualSync) {
              const target = configResolve(this.app.vault.configDir, vr);
              await ensureParentFolders(this.app.vault.adapter, target);
              const buffer2 = data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
              );
              await this.app.vault.adapter.writeBinary(target, buffer2);
              this.lastVisualApplyAt = Date.now();
            }
            return;
          }
          await ensureParentFolders(this.app.vault.adapter, path);
          const buffer = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength
          );
          await this.app.vault.adapter.writeBinary(path, buffer);
        },
        readFile: async (path) => {
          const vr = VisualSync.relPath(path);
          const real = vr !== null ? this.state.visualSync ? configResolve(this.app.vault.configDir, vr) : null : path;
          if (real === null) return null;
          try {
            return new Uint8Array(await this.app.vault.adapter.readBinary(real));
          } catch (e) {
            return null;
          }
        },
        stat: async (path) => {
          const vr = VisualSync.relPath(path);
          const real = vr !== null ? this.state.visualSync ? configResolve(this.app.vault.configDir, vr) : null : path;
          if (real === null) return null;
          const stat = await this.app.vault.adapter.stat(real).catch(() => null);
          return (stat == null ? void 0 : stat.type) === "folder" ? "folder" : (stat == null ? void 0 : stat.type) === "file" ? "file" : null;
        },
        remove: async (path) => {
          const vr = VisualSync.relPath(path);
          if (vr !== null) {
            if (!this.state.visualSync) return;
            const target = configResolve(this.app.vault.configDir, vr);
            if (await this.app.vault.adapter.exists(target)) {
              await this.app.vault.adapter.remove(target);
            }
            return;
          }
          if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
          }
        },
        rename: async (oldPath, newPath) => {
          var _a;
          const oldVr = VisualSync.relPath(oldPath);
          if (oldVr !== null) {
            if (!this.state.visualSync) return;
            const from = configResolve(this.app.vault.configDir, oldVr);
            const to = configResolve(this.app.vault.configDir, (_a = VisualSync.relPath(newPath)) != null ? _a : newPath);
            if (!await this.app.vault.adapter.exists(from)) return;
            await ensureParentFolders(this.app.vault.adapter, to);
            await this.app.vault.adapter.rename(from, to);
            return;
          }
          if (!await this.app.vault.adapter.exists(oldPath)) return;
          await ensureParentFolders(this.app.vault.adapter, newPath);
          await this.app.vault.adapter.rename(oldPath, newPath);
        }
      },
      (status) => this.setStatusBar(status),
      (message, timeout) => this.notify(message, timeout),
      {
        client: this.client,
        staging: this.staging,
        scanner: {
          listFiles: async () => {
            const files = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof import_obsidian6.TFile);
            const stats = await Promise.all(
              files.map(async (f) => {
                var _a;
                const stat = await this.app.vault.adapter.stat(f.path).catch(() => null);
                return { path: f.path, size: (_a = stat == null ? void 0 : stat.size) != null ? _a : 0 };
              })
            );
            return stats;
          },
          readBytes: async (path) => {
            return await this.app.vault.adapter.readBinary(path);
          }
        }
      }
    );
    this.statusItem = null;
    this.lastNoticeAt = /* @__PURE__ */ new Map();
    this.visualTimer = null;
    /** Set when a remote visual appearance change was applied to this device. */
    this.lastVisualApplyAt = 0;
  }
  /** Manual trigger for the visual-appearance mirror. */
  syncVisualNow() {
    if (this.state.visualSync) void this.visual.scan();
  }
  notify(message, timeout) {
    var _a;
    const now = Date.now();
    if (((_a = this.lastNoticeAt.get(message)) != null ? _a : 0) + 5e3 > now) return;
    this.lastNoticeAt.set(message, now);
    new import_obsidian6.Notice(message, timeout != null ? timeout : 5e3);
  }
  async onload() {
    await this.state.load();
    this.client.setServerUrl(this.state.serverUrl);
    this.statusItem = this.addStatusBarItem();
    this.setStatusBar("idle");
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.engine.syncNow();
      }
    });
    this.addSettingTab(
      new SyncVaultSettingsTab(this.app, this, this.state, this.auth, this.client, this.engine, () => {
        void this.engine.start();
        this.setStatusBar("synced");
      })
    );
    this.registerVaultEvents();
    void this.engine.start();
    this.syncVisualNow();
    this.visualTimer = window.setInterval(() => this.syncVisualNow(), 30 * 60 * 1e3);
  }
  setStatusBar(status) {
    var _a;
    if (this.statusItem) {
      this.statusItem.setText((_a = STATUS_ICONS[status]) != null ? _a : STATUS_ICONS.idle);
    }
  }
  registerVaultEvents() {
    const vault = this.app.vault;
    const track = (ev) => this.watcher.track(ev);
    const handle = (kind, path, oldPath) => {
      const rel = configRel(path);
      if (rel !== null) {
        if (!this.state.visualSync) return;
        const logical = this.visual.translate(rel);
        if (!logical) return;
        if (oldPath !== void 0) {
          const oldRel = configRel(oldPath);
          if (oldRel === null) return;
          const oldLogical = this.visual.translate(oldRel);
          if (oldLogical === null) return;
          track({ kind, path: logical, oldPath: oldLogical });
          return;
        }
        track({ kind, path: logical });
        return;
      }
      track({ kind, path, oldPath });
    };
    this.registerEvent(vault.on("create", (file) => {
      if (file instanceof import_obsidian6.TFile) handle("create", file.path);
    }));
    this.registerEvent(vault.on("modify", (file) => {
      if (file instanceof import_obsidian6.TFile) handle("modify", file.path);
    }));
    this.registerEvent(vault.on("delete", (file) => {
      if (file instanceof import_obsidian6.TFile) handle("delete", file.path);
    }));
    this.registerEvent(vault.on("rename", (file, oldPath) => {
      if (file instanceof import_obsidian6.TFile) handle("rename", file.path, oldPath);
    }));
  }
  onunload() {
    var _a;
    if (this.visualTimer !== null) {
      window.clearInterval(this.visualTimer);
      this.visualTimer = null;
    }
    this.engine.stop();
    (_a = this.statusItem) == null ? void 0 : _a.remove();
  }
};
