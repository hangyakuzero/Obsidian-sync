# SyncVault execution plan

Source of truth: `implementation.md`. Diagnosis appendix: `bugfix.md`.

Three phases; each ends green on root tests + plugin build. Phase 1 is the
reliability cut (no wire-format change, backward compatible). Phase 2 is the
chunked protocol (16 MiB). Phase 3 is visual sync + Recover guide.

## Phase 1 — Reliability cut (W1–W8)

### W1. Ordered queue reducer + causal parents
- `plugin/src/sync/ChangeQueue.ts`: replace destructive path coalescing with an
  ordered reducer. Preserve chains (update→rename, rename→update); fold
  delete-then-rename-into-target; collapse superseded ops and **rewire
  `causalParents`** to the surviving op ids touching each affected path. Never
  rebase `baseRevision` (capture-time base).
- `shared/src/index.ts`: `Change.causalParents?: string[]` (validate: ≤16, valid
  op ids).
- `worker VaultSyncDO`: `path_state.last_operation_id`; conflict check allows a
  stale path when its `last_operation_id` is a declared same-device parent.
  Unrelated remote changes still conflict.

### W2. Cursor rules + converge loop
- `Connection.advanceCursorOnAccept`: HTTP false, WS true (WS: `accepted` queued
  behind the `remoteChain` so broadcast order guarantees safety).
- `flushQueue` never advances the cursor on accept; only `applyRemoteChange`
  advances (in revision order).
- `pollOnce` converges: pull→apply until empty (10-batch cap) → flush queue →
  pull→apply until empty; if a cap is reached keep status "syncing" and
  schedule an immediate continuation (never a false "Synced").

### W3. Staged-file queue + crash-safe state — DONE
- `plugin/src/storage/Staging.ts` (new): durable staged content under
  `{configDir}/plugins/syncvault/staging/<operationId>` via the vault adapter
  (`.obsidian` is excluded from sync). `data.json` holds metadata +
  `stagedFile` reference only.
- SyncState/ChangeQueue: serialize all mutations through one mutex; startup
  reconciliation (drop orphans); legacy inline payloads migrated to staging on
  start (`migrateLegacyPayloads`).

### W4. Applied-operation journal + idempotent safe apply — DONE
- `plugin/src/storage/Journal.ts` (new): persisted `{operationId, revision,
  paths}` capped list, authority for "already applied".
- `SyncEngine.apply`:
  - journal-proven ops are skipped on redelivery (lost ACK / HTTP pull).
  - delete: missing target = no-op.
  - rename: source missing + dest exists → no-op (journaled); both missing →
    pause once, never ACK; occupied destination → deterministic
    `(conflict-local-…)` copy queued for sync, then rename; case-only rename →
    two-step through `.`-prefixed `-syncvault-{hex}` temp in the same folder.
  - file-vs-folder ancestor → blocking file backed up as queued conflict copy,
    then folders are created by the write.
- Before applying a remote change, flush pending local observations for its
  paths first (`applyRemoteChange` → `watcher.flush()`).

### W5. Expected-op suppression — DONE
- `VaultWatcher`: time TTL replaced with `{path, op, sha}` expectations recorded
  by the engine before each remote fs write; only matching follow-up events are
  consumed (content matched by hash at flush; deletes/renames by kind + oldPath;
  post-rename metadata touches tolerated). A mismatched event or hash is a real
  local edit and queues immediately. Expectations expire in ~5 s (injectable).
- Watch/event layer filters to `TFile` only.

### W6. Server: atomic sync, retention, dedupe, case collisions
- `VaultSyncDO.syncSince(deviceId, cursor)`: one consistent read (heartbeat +
  retention + ordered batch) replacing the `status()`+`changesAfter()` dual RPC.
- Push `RESYNC_REQUIRED` (460) when `baseRevision < minRetained - 1`, gated on
  an explicit capability marker so legacy clients never drop queued changes.
  New clients preserve the queue and enter a stable recovery state.
- ACK clamp to `currentRevision`; reject malformed; heartbeat on HTTP
  pull/push/ack.
- Fix dead GC alarm: schedule on init and every commit (currently only
  re-scheduled inside `alarm()` — automatic GC never starts).
- Purge `operation_receipts` with pruned changes; purge delete tombstones from
  `path_state` once unreferenced; keep live-file metadata.
- Identical-content dedupe: `path_state.content_hash`; stale upsert with same
  hash → receipt + accepted, no revision, no conflict copy.
- Case collisions: `collision_key` (NFC + casefold); same-key **live** other
  path → deterministic conflict copy for the second version; case-only rename
  commits cleanly (dest tombstone created by the rename itself).
- SQLite storage-full → `INSUFFICIENT_STORAGE` (507), client keeps queue.

### W7. Request deadlines
- `SyncClient`: every `requestUrl` gets a `timeout` (pull 15 s, push/upload
  30 s, auth/ack 10 s); timeouts raise retryable errors (offline), never 401.

### W8. Auth recovery UX + 3-strike 401 — DONE
- `AccountDO.registerDevice`: same account+vault+deviceId → rotate token in
  place and return the new token (no more lockout after reconnect); cross-vault
  re-registration of an existing device still rejected (409). Foreign accounts
  can never collide (devices table is per-account DO storage), checked anyway.
- Settings "Reconnect vault" (`ReconnectModal`, password only): re-registers the
  stored identity (`AuthManager.reconnect`), rotates token, keeps
  cursor/queue/staging/journal untouched, then `engine.authRecovered()` resets
  the strike counter and resumes polling.
- 401 policy in `SyncEngine.handleAuthFailure`: first two consecutive failures
  warn with a `/3` counter and keep retrying; third pauses once with a notice
  pointing at Settings → Reconnect vault. Counter resets on any successful pull
  (welcome) or reconnect. Timeouts/5xx remain retryable (never 401).
- `Disconnect vault` stays the explicit unlink. Rebuild/Join unchanged until
  Phase 3's Recover guide.
- Tests: worker `rotates token` HTTP test (rotation, old token 401, new token
  200, cross-vault 409). Plugin suite unchanged-green.

### Phase 1 tests — DONE (75 plugin + 24 worker, tsc clean)
- Worker: syncSince atomic batch + heartbeat; marker-gated push RESYNC_REQUIRED;
  identical-content dedupe; causal-parent acceptance / unrelated-remote
  rejection; token rotation (old rejected, new works, cross-account 409); ACK
  clamp; alarm scheduling; receipt/tombstone purge; case collision
  (Foo.md/foo.md → deterministic copy; case-only rename clean).
- Plugin: reducer chains + parent rewiring + restart mid-chain; HTTP
  no-cursor-jump + convergence; WS accepted ordering; staging promote/reconcile/
  migration; journal idempotency; occupied-rename backup + queue; case-only
  two-step; file-vs-folder; expected-op suppression; 3-strike 401 → Reconnect
  (`handleAuthFailure` ×3 pauses, `authRecovered()` resumes → synced); Reconnect
  preserves queue/cursor (`AuthManager.reconnect` rotates token only);
  deadlines.

### Phase 1 release: plugin + worker patch, backward compatible (v0.2.0).

## Phase 2 — Protocol v2: chunked content (16 MiB) — DONE
- `Change.content {hash, byteLength, chunkCount}`; `upload_sessions`/
  `upload_chunks`/`change_chunks` tables (chunks ≤ 256 KiB); begin → chunks
  (sized/validated per chunk) → verified commit (SHA-256 check, HASH_MISMATCH)
  → submit + broadcast; resumable (begin returns uploaded set, dedupe to same
  receipt revision); download by revision+index with plugin-side hash
  verification before apply; 24 h incomplete-upload expiry via DO alarm sweep
  (`UPLOAD_EXPIRY_MS`); `CLIENT_UPGRADE_REQUIRED` gating on pull (and strict
  push) without `chunks-v1`; legacy inline payload support during migration
  (W4 `migrateLegacyPayloads`); 16 MiB cap enforced end-to-end
  (`MAX_FILE_BYTES` in `isValidContentReference`, payload guard, scanner and
  capture-time skips, descriptor validation at `beginUpload`).

## Phase 3 — Visual sync + Recover guide
- "Sync visual appearance" (default on for new + migrated) — DONE:
  - `VisualSync` coordinator + `visualSync` flag (SyncState, default on, per-device;
    unknown keys survive `load()`/`save()` untouched). Scope = `appearance.json`
    + every installed theme folder under `.obsidian`.
  - Logical namespace `syncvault-visual/…` ↔ `vault.configDir` mapping in main.ts
    (VaultOps write/read/stat/remove/rename + watcher.readBytes + event
    translation in `registerVaultEvents`); renamed config events map both sides;
    out-of-scope `.obsidian` files (workspace, hotkeys, plugin data) stay ignored.
  - Scanner: startup + manual ("Sync visual files now") + 30-min cadence; recurses
    theme trees (depth ≤ 8); 16 MiB cap with notice. Small files (≤1 MiB) inline
    payload, larger staged via `engine.enqueueVisualChange` (conflict-copy path),
    zero-byte → empty payload; server identical-content dedupe makes blind
    re-scans harmless. Disabled → event capture dropped and remote applies
    advance the cursor without writing.
  - Passive status: settings row says changes take effect after Obsidian
    restarts (never hot-swaps the UI); `lastVisualApplyAt` tracked.
  - Tests: `VisualSync.test.ts` (translate/relPath/scan/oversize) + engine
    `enqueueVisualChange` inline/staged/zero-byte.
- "Recover sync" guide replaces Rebuild/Join — DONE:
  - `RecoverModal` (guided flow, two modes): "Reset baseline from this device"
    (password-gated; local safety check via `engine.countSyncableFiles()` —
    refuses to wipe server history when this device has no syncable files or
    the scan fails) and "Pull rebuilt baseline" (join: cursor reset, no local
    seeding).
  - Join preserves local files as conflict copies: `engine.enterJoinMode()`
    sets a one-shot `joinBackup` flag; during the baseline pull, any remote
    create/update whose target has differing local bytes backs the local file
    up under `(conflict-local-…)` and queues it for upload before overwriting.
    Flag auto-clears when the pull converges (and on stop).
  - `RebuildModal` deleted; Settings "Rescue" → "Recover sync".
  - Tests: join divergent-backup (regex path, target overwritten, backup
    queued, ACK), identical-file untouched, `countSyncableFiles` filter
    (.obsidian/oversize/empty excluded).
- Release: plugin feature version + deploy.

## Defaults (locked by implementation.md)
- Retention 7 days; max file 16 MiB chunked; visual on by default; conflicts
  preserve both versions; guided authoritative-device recovery.