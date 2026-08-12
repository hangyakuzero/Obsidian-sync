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
var import_obsidian4 = require("obsidian");

// src/ui/SettingsTab.ts
var import_obsidian2 = require("obsidian");

// src/ui/WelcomeModal.ts
var import_obsidian = require("obsidian");

// src/auth/AuthManager.ts
var AuthManager = class _AuthManager {
  constructor(state, client) {
    this.state = state;
    this.client = client;
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
};

// src/ui/WelcomeModal.ts
var WelcomeModal = class extends import_obsidian.Modal {
  constructor(app, auth, onDone) {
    super(app);
    this.auth = auth;
    this.onDone = onDone;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Welcome to SyncVault" });
    contentEl.createEl("p", { text: "Synchronize this vault between your devices." });
    new import_obsidian.Setting(contentEl).addButton(
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
var NewUserModal = class extends import_obsidian.Modal {
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
    contentEl.createEl("h2", { text: "Create account" });
    if (this.deviceName === "Desktop") {
      this.deviceName = "Desktop";
    }
    new import_obsidian.Setting(contentEl).setName("Account ID").addText((t) => {
      t.setValue(this.accountId);
      t.onChange((v) => this.accountId = v.trim());
    });
    new import_obsidian.Setting(contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => this.password = v);
    });
    new import_obsidian.Setting(contentEl).setName("Vault name").addText((t) => {
      t.setValue("My Notes");
      t.onChange((v) => this.vaultName = v.trim());
    });
    new import_obsidian.Setting(contentEl).setName("Device name").addText((t) => {
      t.setValue(this.deviceName);
      t.onChange((v) => this.deviceName = v.trim());
    });
    new import_obsidian.Setting(contentEl).addButton(
      (b) => b.setButtonText("Create").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          await this.auth.newUser({
            accountId: this.accountId,
            password: this.password,
            vaultName: this.vaultName || "My Notes",
            deviceName: this.deviceName
          });
          new import_obsidian.Notice("SyncVault: account and vault created");
          this.close();
          this.onDone();
        } catch (e) {
          new import_obsidian.Notice(`SyncVault: ${e.message}`, 6e3);
          b.setDisabled(false);
        }
      })
    );
  }
};
var ExistingUserModal = class extends import_obsidian.Modal {
  constructor(app, auth, onDone) {
    super(app);
    this.auth = auth;
    this.onDone = onDone;
    this.accountId = "";
    this.password = "";
    this.deviceName = "";
    this.vaults = [];
    this.selectedVaultId = "";
    const ua = navigator.userAgent;
    this.deviceName = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : "Desktop";
  }
  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Sign in" });
    new import_obsidian.Setting(contentEl).setName("Account ID").addText((t) => {
      t.setPlaceholder("user1234");
      t.onChange((v) => this.accountId = v.trim());
    });
    new import_obsidian.Setting(contentEl).setName("Password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => this.password = v);
    });
    new import_obsidian.Setting(contentEl).setName("Device name").addText((t) => {
      t.setValue(this.deviceName);
      t.onChange((v) => this.deviceName = v.trim());
    });
    new import_obsidian.Setting(contentEl).addButton(
      (b) => b.setButtonText("Sign in").setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          this.vaults = await this.auth.fetchVaults(this.accountId, this.password);
        } catch (e) {
          new import_obsidian.Notice(`SyncVault: ${e.message}`, 6e3);
          b.setDisabled(false);
          return;
        }
        if (this.vaults.length === 0) {
          new import_obsidian.Notice("SyncVault: no vaults found", 6e3);
          b.setDisabled(false);
          return;
        }
        this.renderVaultPicker();
        this.selectedVaultId = this.vaults[0].vaultId;
        b.setDisabled(false);
      })
    );
  }
  renderVaultPicker() {
    const { contentEl } = this;
    const setting = new import_obsidian.Setting(contentEl).setName("Vault to sync");
    setting.addDropdown((d) => {
      for (const v of this.vaults) d.addOption(v.vaultId, v.name);
      d.onChange((v) => this.selectedVaultId = v);
    });
    new import_obsidian.Setting(contentEl).addButton(
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
          new import_obsidian.Notice("SyncVault: vault linked");
          this.close();
          this.onDone();
        } catch (e) {
          new import_obsidian.Notice(`SyncVault: ${e.message}`, 6e3);
          b.setDisabled(false);
        }
      })
    );
  }
};

// src/ui/SettingsTab.ts
var STATUS_LABELS = {
  idle: "idle",
  syncing: "\u21BB Syncing",
  downloading: "\u2193 Downloading",
  uploading: "\u2191 Uploading",
  conflict: "\u26A0 Conflict",
  offline: "\u2715 Offline",
  synced: "\u2713 Synced"
};
var SyncVaultSettingsTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin, state, auth, client, engine, afterSetup) {
    super(app, plugin);
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
    containerEl.createEl("h2", { text: "SyncVault" });
    new import_obsidian2.Setting(containerEl).setName("Server URL").addText((t) => {
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
    new import_obsidian2.Setting(containerEl).setName("Account").setDesc((_a = this.state.accountId) != null ? _a : "");
    new import_obsidian2.Setting(containerEl).setName("Vault").setDesc((_c = (_b = this.state.vaultName) != null ? _b : this.state.vaultId) != null ? _c : "");
    new import_obsidian2.Setting(containerEl).setName("Device").setDesc((_e = (_d = this.state.deviceName) != null ? _d : this.state.deviceId) != null ? _e : "");
    new import_obsidian2.Setting(containerEl).setName("Status").setDesc(
      `${STATUS_LABELS[this.engine.status]} \xB7 revision ${this.state.lastRevision} \xB7 ${this.engine.pendingCount} pending`
    );
    new import_obsidian2.Setting(containerEl).addButton(
      (b) => b.setButtonText("Sync now").setCta().onClick(() => {
        void this.engine.syncNow().then(() => this.display());
      })
    );
    new import_obsidian2.Setting(containerEl).addButton(
      (b) => b.setButtonText("Disconnect vault").onClick(async () => {
        await this.state.disconnect();
        new import_obsidian2.Notice("SyncVault: vault disconnected");
        this.display();
      })
    );
  }
  renderWelcome(parent) {
    parent.createEl("p", { text: "Welcome to SyncVault. Link this vault to sync it between your devices." });
    new import_obsidian2.Setting(parent).addButton(
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
  appliedPaths: []
};
var SyncState = class {
  constructor(backend) {
    this.backend = backend;
    this.data = { ...DEFAULT_SYNC_DATA, pendingChanges: [] };
  }
  get connected() {
    return Boolean(
      this.data.accountId && this.data.vaultId && this.data.deviceId && this.data.deviceToken
    );
  }
  get serverUrl() {
    return this.data.serverUrl;
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
  async load() {
    var _a;
    const saved = await ((_a = this.backend) == null ? void 0 : _a.load());
    if (saved) {
      this.data = { ...DEFAULT_SYNC_DATA, pendingChanges: [], ...saved };
      if (!Array.isArray(this.data.pendingChanges)) this.data.pendingChanges = [];
      if (!Array.isArray(this.data.appliedPaths)) this.data.appliedPaths = [];
    }
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
  async save(patch) {
    var _a;
    Object.assign(this.data, patch);
    await ((_a = this.backend) == null ? void 0 : _a.save(this.data));
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
    await this.save({
      accountId: void 0,
      vaultId: void 0,
      vaultName: void 0,
      deviceId: void 0,
      deviceName: void 0,
      deviceToken: void 0,
      lastRevision: 0,
      seeded: false,
      appliedPaths: []
    });
  }
};

// src/api/SyncClient.ts
var import_obsidian3 = require("obsidian");
var ApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiError";
  }
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
      body: { accountId, password }
    });
  }
  async login(accountId, password) {
    await this.request("/v1/login", { method: "POST", body: { accountId, password } });
  }
  async createVault(accountId, password, name) {
    return this.request("/v1/vaults", {
      method: "POST",
      body: { accountId, password, name }
    });
  }
  async listVaultsByPassword(accountId, password) {
    const res = await this.request("/v1/vaults/list", {
      method: "POST",
      body: { accountId, password }
    });
    return res.vaults;
  }
  async listVaults(accountId, deviceId, token) {
    const res = await this.request("/v1/vaults", {
      headers: { Authorization: `Bearer ${accountId}:${deviceId}:${token}` }
    });
    return res.vaults;
  }
  async registerDevice(accountId, vaultId, password, deviceId, deviceName) {
    return this.request(`/v1/vaults/${vaultId}/devices`, {
      method: "POST",
      body: { accountId, password, deviceId, name: deviceName }
    });
  }
  buildWsUrl(accountId, vaultId, deviceId) {
    const wsBase = this.base.replace(/^http/, "ws");
    const params = new URLSearchParams({ accountId, deviceId });
    return `${wsBase}/v1/vaults/${vaultId}/ws?${params.toString()}`;
  }
  async request(path, opts = {}) {
    var _a, _b, _c;
    const headers = { "Content-Type": "application/json", ...opts.headers };
    const response = await (0, import_obsidian3.requestUrl)({
      url: `${this.base}${path}`,
      method: (_a = opts.method) != null ? _a : "GET",
      headers,
      body: opts.body !== void 0 ? JSON.stringify(opts.body) : void 0
    });
    if (response.status >= 400) {
      let code = "INTERNAL";
      let message = response.text || "request failed";
      try {
        const parsed = JSON.parse(response.text);
        code = (_b = parsed.error) != null ? _b : code;
        message = (_c = parsed.message) != null ? _c : message;
      } catch (e) {
      }
      throw new ApiError(response.status, code, message);
    }
    return response.json;
  }
  async pullChanges(accountId, vaultId, deviceId, token, since) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    const res = await this.request(`/v1/vaults/${vaultId}/sync?since=${since}`, { headers: { Authorization: auth } });
    return res;
  }
  async pushChange(accountId, vaultId, deviceId, token, change) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    return this.request(`/v1/vaults/${vaultId}/changes`, {
      method: "POST",
      headers: { Authorization: auth },
      body: { ...change, deviceId }
    });
  }
  async sendAck(accountId, vaultId, deviceId, token, revision) {
    const auth = `Bearer ${accountId}:${deviceId}:${token}`;
    await this.request(`/v1/vaults/${vaultId}/ack`, {
      method: "POST",
      headers: { Authorization: auth },
      body: { revision }
    });
  }
};

// src/sync/ChangeQueue.ts
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
   * Coalesces pending changes for a path: a later write supersedes an earlier
   * pending write/delete for the same path; a rename supersedes pending ops on
   * either side of the move.
   */
  async enqueue(change) {
    const pending = this.state.pendingChanges;
    const touched = /* @__PURE__ */ new Set([change.path]);
    if (change.oldPath) touched.add(change.oldPath);
    for (const key of touched) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const c = pending[i];
        if (c.path === key || c.oldPath === key) {
          pending.splice(i, 1);
        }
      }
    }
    const already = pending.some(
      (c) => c.operation === change.operation && c.path === change.path && c.oldPath === change.oldPath && c.payload === change.payload
    );
    if (!already) {
      pending.push({ ...change, attempts: 0 });
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

// ../shared/src/index.ts
var MAX_FILE_BYTES = 1048576;
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

// src/vault/VaultWatcher.ts
var DEBOUNCE_MS = 800;
var SUPPRESS_TTL_MS = 6e4;
var VaultWatcher = class {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = /* @__PURE__ */ new Map();
    this.suppressed = /* @__PURE__ */ new Map();
    this.flushTimer = null;
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
    if (this.isSuppressed(path)) return;
    if (ev.kind === "rename" && this.isSuppressed(ev.oldPath)) return;
    const key = this.keyOf(ev);
    if (ev.kind === "delete") {
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      this.pending.delete(`rename:${path}`);
    } else if (ev.kind === "rename") {
      const { oldPath } = ev;
      this.pending.delete(`create:${oldPath}`);
      this.pending.delete(`modify:${oldPath}`);
      this.pending.delete(`delete:${oldPath}`);
      this.pending.delete(`rename:${oldPath}`);
      this.pending.delete(`create:${path}`);
      this.pending.delete(`modify:${path}`);
      this.pending.delete(`delete:${path}`);
    } else {
      this.pending.delete(`delete:${path}`);
      this.pending.delete(`rename:${path}`);
      this.pending.delete(ev.kind === "create" ? `modify:${path}` : `create:${path}`);
    }
    this.pending.set(key, ev);
    this.scheduleFlush();
  }
  /** Suppress vault events for paths being modified by remote-change application. */
  suppress(paths) {
    const until = Date.now() + SUPPRESS_TTL_MS;
    for (const p of paths) {
      try {
        this.suppressed.set(normalizePath(p), until);
      } catch (e) {
      }
    }
  }
  releaseAll() {
    this.suppressed.clear();
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
    const bytes = await this.ctx.readBytes(ev.path);
    if (bytes === null) return;
    if (bytes.byteLength > MAX_FILE_BYTES) {
      (_c = (_b = this.ctx).onTooLarge) == null ? void 0 : _c.call(_b, ev.path, bytes.byteLength);
      return;
    }
    const change = {
      operationId: this.newOperationId(),
      revision: 0,
      deviceId: "",
      path: normalizePath(ev.path),
      operation: ev.kind === "modify" ? "update" : "create",
      baseRevision: this.ctx.getBaseRevision(),
      timestamp: Date.now(),
      payload: toBase64(new Uint8Array(bytes))
    };
    await this.ctx.onChange(change);
  }
  keyOf(ev) {
    return ev.kind === "rename" ? `rename:${ev.path}` : `${ev.kind}:${ev.path}`;
  }
  isSyncable(path) {
    if (path === ".obsidian" || path.startsWith(".obsidian/")) return false;
    return true;
  }
  isSuppressed(path) {
    const until = this.suppressed.get(path);
    if (until === void 0) return false;
    if (until < Date.now()) {
      this.suppressed.delete(path);
      return false;
    }
    return true;
  }
  newOperationId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
};

// src/sync/SyncConnection.ts
var RETRY_BACKOFFS = [2e3, 5e3, 1e4, 3e4];
var FATAL_CLOSE_REASONS = /* @__PURE__ */ new Set([4001, 4400, 4401, 4402]);
var SyncConnection = class {
  constructor(params, callbacks) {
    this.params = params;
    this.callbacks = callbacks;
    this.ws = null;
    this.status = "idle";
    this.manualClose = false;
    this.retryIndex = 0;
    this.retryTimer = null;
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
        this.send({ type: "hello", accountId: p.accountId, vaultId: p.vaultId, deviceId: p.deviceId, token: p.token, lastRevision: p.getLastRevision() });
      };
      ws.onmessage = (event) => this.dispatch(event);
      ws.onclose = (event) => this.handleClose(event);
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
  sendChange(change) {
    return this.send({ type: "change", change });
  }
  sendAck(revision) {
    return this.send({ type: "ack", revision });
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
    switch (msg.type) {
      case "welcome":
        this.setStatus("open");
        this.callbacks.onWelcome(msg.serverRevision, msg.resyncRequired);
        break;
      case "change":
        this.callbacks.onRemoteChange(msg.change);
        break;
      case "accepted":
        this.callbacks.onAccepted(msg.operationId, msg.revision);
        break;
      case "conflict":
        this.callbacks.onConflict({
          operationId: msg.operationId,
          path: msg.path,
          conflictPath: msg.conflictPath,
          serverRevision: msg.serverRevision
        });
        break;
      case "error":
        this.callbacks.onError(msg.message);
        break;
    }
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
var HTTP_ACK_TIMEOUT_MS = 3e4;
var HttpConnection = class {
  constructor(state, client, callbacks) {
    this.state = state;
    this.client = client;
    this.callbacks = callbacks;
    this.connectedFlag = false;
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
    var _a, _b, _c, _d;
    const r = await this.client.pullChanges(
      (_a = this.state.accountId) != null ? _a : "",
      (_b = this.state.vaultId) != null ? _b : "",
      (_c = this.state.deviceId) != null ? _c : "",
      (_d = this.state.deviceToken) != null ? _d : "",
      since
    );
    return { currentRevision: r.currentRevision, changes: r.changes, resyncRequired: r.resyncRequired };
  }
  sendChange(change) {
    const p = this.params();
    void this.push(change, p);
    return true;
  }
  sendAck(revision) {
    const p = this.params();
    void this.client.sendAck(p.accountId, p.vaultId, p.deviceId, p.token, revision).catch(() => void 0);
    return true;
  }
  async push(change, p) {
    const timeout = setTimeout(() => {
    }, HTTP_ACK_TIMEOUT_MS);
    try {
      const result = await this.client.pushChange(p.accountId, p.vaultId, p.deviceId, p.token, change);
      if (result.status === "accepted") {
        this.callbacks.onAccepted(change.operationId, result.revision);
      } else {
        this.callbacks.onConflict({
          operationId: change.operationId,
          path: result.path,
          conflictPath: result.conflictPath,
          serverRevision: result.serverRevision
        });
      }
    } catch (e) {
      this.callbacks.onError(`push failed: ${e.message}`);
      clearTimeout(timeout);
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
var DEFAULT_POLL_INTERVAL_MS = 4e3;
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
    var _a, _b, _c;
    this.pollIntervalMs = (_a = options.pollIntervalMs) != null ? _a : DEFAULT_POLL_INTERVAL_MS;
    this.scanner = options.scanner;
    const handlers = {
      onWelcome: (serverRevision, resyncRequired) => this.handleWelcome(serverRevision, resyncRequired),
      onRemoteChange: (change) => void this.applyRemoteChange(change),
      onAccepted: (operationId, revision) => this.settleAck(operationId, { accepted: true, revision }),
      onConflict: (c) => this.settleAck(c.operationId, { accepted: false, conflictPath: c.conflictPath }),
      onError: (message) => this.onNotice(`SyncVault: ${message}`, 6e3),
      onStatusChange: (status) => this.handleConnectionStatus(status)
    };
    this.connection = (_c = (_b = options.connectionFactory) == null ? void 0 : _b.call(options, handlers)) != null ? _c : options.client ? new HttpConnection(state, options.client, handlers) : new SyncConnection(
      () => {
        var _a2, _b2, _c2, _d;
        return {
          serverUrl: this.state.serverUrl,
          accountId: (_a2 = this.state.accountId) != null ? _a2 : "",
          vaultId: (_b2 = this.state.vaultId) != null ? _b2 : "",
          deviceId: (_c2 = this.state.deviceId) != null ? _c2 : "",
          token: (_d = this.state.deviceToken) != null ? _d : "",
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
  async start() {
    if (!this.state.connected) return;
    this.connection.connect();
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
    }
    await this.pollOnce();
  }
  stop() {
    this.connection.disconnect();
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.setStatus("idle");
  }
  async syncNow() {
    if (!this.state.connected) {
      this.onNotice("SyncVault: not configured", 4e3);
      return;
    }
    this.connection.connect();
    await this.pollOnce();
  }
  async pollOnce() {
    if (!this.state.connected) return;
    if (this.polling) return;
    if (!this.connection.connected) return;
    this.polling = true;
    try {
      const result = await this.connection.pull(this.state.lastRevision);
      if (result.resyncRequired) {
        this.onNotice(
          "SyncVault: local history is older than the server retention window. Resync is not supported yet.",
          1e4
        );
        this.setStatus("conflict");
        return;
      }
      if (result.changes.length > 0) this.setStatus("downloading");
      for (const change of result.changes) {
        await this.applyRemoteChange(change);
      }
      await this.maybeSeed();
      await this.flushQueue();
      if (this.state.pendingChanges.length === 0) {
        this.setStatus(this.connection.connected ? "synced" : "offline");
      }
    } catch (e) {
      this.setStatus(this.connection.connected ? "offline" : "offline");
    } finally {
      this.polling = false;
    }
  }
  handleConnectionStatus(status) {
    if (status === "offline") {
      this.setStatus("offline");
    } else if (status === "open" && this.statusValue === "offline") {
      this.setStatus("synced");
    }
  }
  async handleWelcome(serverRevision, resyncRequired) {
    if (resyncRequired) {
      this.onNotice("SyncVault: local history is older than the server retention window. Resync is not supported yet.", 1e4);
      this.setStatus("conflict");
      return;
    }
    this.setStatus("synced");
    void this.flushQueue();
  }
  async applyRemoteChange(change) {
    if (this.statusValue === "idle") this.setStatus("downloading");
    const paths = change.oldPath ? [change.path, change.oldPath] : [change.path];
    this.watcher.suppress(paths);
    try {
      await this.apply(change);
      await this.state.markApplied(change.path, change.oldPath);
    } catch (e) {
      this.onNotice(`SyncVault: failed to apply ${change.path}: ${e.message}`, 8e3);
      return;
    } finally {
      this.watcher.releaseAll();
    }
    if (change.revision > this.ackTarget) {
      this.ackTarget = change.revision;
      await this.state.setLastRevision(change.revision);
      this.connection.sendAck(change.revision);
    }
    if (this.queue.size() === 0) this.setStatus("synced");
  }
  /**
   * First-run seed: enqueue every local file as a "create" so a device's
   * existing vault reaches the server. Pulled paths (marked applied) are
   * skipped, preventing duplicates and false conflicts on joined devices.
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
      await this.queue.enqueue({
        operationId: this.newOperationId(),
        revision: 0,
        deviceId: "",
        path: f.path,
        operation: "create",
        baseRevision: this.state.lastRevision,
        timestamp: Date.now()
      });
    }
    await this.state.markSeeded();
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
  async apply(change) {
    switch (change.operation) {
      case "create":
      case "update": {
        if (!change.payload) throw new Error("missing payload");
        await this.vault.write(normalizePath(change.path), fromBase64(change.payload));
        return;
      }
      case "delete":
        await this.vault.remove(normalizePath(change.path));
        return;
      case "rename": {
        if (!change.oldPath) throw new Error("rename missing oldPath");
        await this.vault.rename(normalizePath(change.oldPath), normalizePath(change.path));
        return;
      }
    }
  }
  async flushQueue() {
    if (!this.connection.connected) return;
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.setStatus(this.queue.size() > 0 ? "uploading" : this.statusValue);
    try {
      for (const item of [...this.queue.items]) {
        if (!this.connection.connected) break;
        const result = await this.sendAndWait(item);
        if (result === null) break;
        await this.queue.remove(item.operationId);
        if (result.accepted) {
          await this.state.setLastRevision(result.revision);
        } else {
          this.setStatus("conflict");
        }
      }
    } finally {
      this.syncInFlight = false;
      if (this.connection.connected) this.setStatus(this.queue.size() > 0 ? "syncing" : "synced");
    }
  }
  sendAndWait(item) {
    if (!this.connection.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      var _a;
      const timer = setTimeout(() => {
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(item.operationId, { resolve, timer });
      const wireChange = { ...item, deviceId: (_a = this.state.deviceId) != null ? _a : "" };
      if (!this.connection.sendChange(wireChange)) {
        clearTimeout(timer);
        this.pendingAcks.delete(item.operationId);
        resolve(null);
      }
    });
  }
  settleAck(operationId, result) {
    const pending = this.pendingAcks.get(operationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(operationId);
    pending.resolve(result);
  }
  setStatus(status) {
    if (this.statusValue !== status) {
      this.statusValue = status;
      this.onStatus(status);
    }
  }
};

// src/main.ts
var STATUS_ICONS = {
  idle: "SyncVault: \u2713",
  syncing: "SyncVault: \u21BB Syncing",
  downloading: "SyncVault: \u2193 Downloading",
  uploading: "SyncVault: \u2191 Uploading",
  conflict: "SyncVault: \u26A0 Conflict",
  offline: "SyncVault: \u2715 Offline",
  synced: "SyncVault: \u2713 Synced"
};
var SyncVaultPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.state = new SyncState({
      load: () => this.loadData(),
      save: (data) => this.saveData(data)
    });
    this.client = new SyncClient("http://localhost:8787");
    this.auth = new AuthManager(this.state, this.client);
    this.queue = new ChangeQueue(this.state);
    this.watcher = new VaultWatcher({
      readBytes: async (path) => {
        try {
          return await this.app.vault.adapter.readBinary(path);
        } catch (e) {
          return null;
        }
      },
      getBaseRevision: () => this.state.lastRevision,
      onChange: (change) => this.queue.enqueue(change),
      onTooLarge: (path, size) => {
        new import_obsidian4.Notice(
          `SyncVault: "${path}" (${(size / 1024 / 1024).toFixed(1)} MB) exceeds the 1 MB sync limit and was not synced`,
          8e3
        );
      }
    });
    this.engine = new SyncEngine(
      this.state,
      this.queue,
      this.watcher,
      {
        write: (path, data) => this.app.vault.adapter.writeBinary(path, data.buffer),
        remove: (path) => this.app.vault.adapter.remove(path),
        rename: (oldPath, newPath) => this.app.vault.adapter.rename(oldPath, newPath)
      },
      (status) => this.setStatusBar(status),
      (message, timeout) => new import_obsidian4.Notice(message, timeout != null ? timeout : 5e3),
      {
        client: this.client,
        scanner: {
          listFiles: async () => {
            const files = this.app.vault.getAllLoadedFiles().filter((f) => f instanceof import_obsidian4.TFile);
            const stats = await Promise.all(
              files.map(async (f) => {
                var _a;
                const stat = await this.app.vault.adapter.stat(f.path).catch(() => null);
                return { path: f.path, size: (_a = stat == null ? void 0 : stat.size) != null ? _a : 0 };
              })
            );
            return stats;
          }
        }
      }
    );
    this.statusItem = null;
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
    this.registerEvent(vault.on("create", (file) => track({ kind: "create", path: file.path })));
    this.registerEvent(vault.on("modify", (file) => track({ kind: "modify", path: file.path })));
    this.registerEvent(vault.on("delete", (file) => track({ kind: "delete", path: file.path })));
    this.registerEvent(vault.on("rename", (file, oldPath) => track({ kind: "rename", path: file.path, oldPath })));
  }
  onunload() {
    var _a;
    this.engine.stop();
    (_a = this.statusItem) == null ? void 0 : _a.remove();
  }
};
