# SyncVault

Self-hosted Obsidian vault synchronization (desktop ↔ mobile) on Cloudflare Workers.

The cloud only **coordinates** devices and temporarily holds unconsumed changes — it is not a backup.
Each device keeps its own vault; no R2, no Postgres, no permanent cloud storage.

## Stack

- **Plugin** — TypeScript Obsidian plugin (`plugin/`), `isDesktopOnly: false`, uses only Obsidian's cross-platform Vault API and `requestUrl`.
- **Worker** — Cloudflare Worker (`worker/`): stateless router, `AccountDO` (accounts, vault registry, device tokens), `VaultSyncDO` (one per vault, SQLite-backed: revision log, path state, device ACKs, garbage collection).
- **Transport** — HTTP polling by default (poll, push, ack endpoints): `requestUrl` is dependable on desktop + mobile. A WebSocket transport (Hibernation API) exists in the codebase for future realtime use.
- **Shared protocol types** — `shared/`.

## How sync works

1. Each change gets a monotonically increasing per-vault `revision`.
2. Device edits are captured by the watcher (debounced, coalesced) into a **persistent local queue** that survives restarts and offline periods.
3. On connect: `hello` with the device token + last-known revision → server replays missing changes (batched) → device applies them with **path-based event suppression** (applied changes never echo back as new uploads) → ACKs.
4. Device flushes its queue; valid writes are committed in server revision order. A later server revision replaces earlier content for the same path. `baseRevision` is retained for protocol compatibility but does not create conflict copies.
5. On first connection each device **seeds** its local files (skipping paths already pulled from the server), so an existing vault reaches the server and new devices download it.
5. Changes are purged once every active device ACKed them or after 7 days; clients older than the retained history get `resync_required` (not implemented in V1).

## Development

```bash
npm install

# 1. Run the backend locally
cd worker && npx wrangler dev --port 8787   # http://localhost:8787

# 2. Build the plugin (watch)
cd plugin && npm run dev                     # -> plugin/main.js

# 3. Install into a dev vault
cp -r plugin data.json main.js manifest.json \
   ~/path/to/vault/.obsidian/plugins/syncvault/
# (copy manifest.json, main.js, styles.css if any; enable SyncVault in Settings → Community plugins)
```

Point the plugin at `http://localhost:8787` in its settings. For an Android device use a deployed worker (`npm run deploy` in `worker/`) with HTTPS.

## Scripts

| Command | Meaning |
|---|---|
| `cd worker && npm run dev` | local Worker + DOs + SQLite (`localhost:8787`) |
| `cd worker && npm run test` | vitest pool-workers: core API, WS sync, mutations, GC, resync |
| `cd worker && npm run deploy` | `wrangler deploy` |
| `cd plugin && npm run dev` | esbuild watch → `main.js` |
| `cd plugin && npm run build` | typecheck + production build |
| `cd plugin && npm run test` | queue / watcher / engine / hashing tests |

## Manual acceptance (planfin §TESTING)

1. Create account on Desktop → create synced vault.
2. Install on Android → sign in → select the vault.
3. Desktop creates `test.md` → appears on mobile.
4. Mobile edits → updates on desktop.
5. Desktop offline; mobile edits; desktop reconnects → catches up.
6. Both edit the same file offline → reconnect → writes are committed in server order and every device converges to the latest server revision. Existing conflict-named files are not automatically removed.

## V1 scope notes

- 1 MiB per-file cap (SQLite row limit), larger files are skipped with a notice.
- A device registering after its vault's history was purged receives `resync_required` (full resync is a future feature).
- No end-to-end encryption yet (payloads travel as plaintext over HTTPS/WSS); the protocol is designed so encryption can be added without redesign.
