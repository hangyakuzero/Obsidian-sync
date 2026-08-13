# SyncVault Bugfix Plan — core sync reliability

Reported symptoms:

- Sync stops at random times; mobile vault "disconnected on its own" and required logging in again.
- `destination file already exists` error pops up repeatedly; sync stays paused.
- The conflict mechanism creates a lot of duplicate `(conflict-…).md` files even when there are 0 real conflicts.

## Root causes

### S1. Push-accept jumps the sync cursor past unseen revisions
`SyncEngine.flushQueue` (`plugin/src/sync/SyncEngine.ts:351-353`) calls `setLastRevision(revision)` on `accepted`. The returned revision is the server's *global* revision counter, so any change another device committed between this device's last pull and its push is **skipped forever** (never applied, never ACKed). Devices silently diverge, and the stale `baseRevision`s then make the server manufacture conflict copies (see S4). This is the main driver of both "0-conflict duplicates" and "sync broken at random".

### S2. "destination file already exists" → permanent pause + endless loop
`VaultOps.rename` (`plugin/src/main.ts:61-68`) calls `app.vault.adapter.rename(oldPath, newPath)`, which throws when the destination already exists (mobile/Capacitor; on desktop it can silently overwrite instead — also a data-loss bug). `SyncEngine.applyRemoteChange` (`SyncEngine.ts:228-238`) catches the throw, sets `paused = true`, and shows a notice. The cursor never advances past the failed change, so every resume / Sync-now re-delivers the same change and fails again → the notice "kept popping up". Re-login did not help because `SyncState.disconnect()` resets `lastRevision = 0`, so reconnecting replays the entire history, including the failing rename.

### S3. 401 on mobile → forced manual re-login
Any HTTP 401 in `HttpConnection.pull`/`push` (`plugin/src/sync/HttpConnection.ts:57-60, 95-100`) fires `handleAuthFailure` (`SyncEngine.ts:200-206`): disconnect + clear pending acks + `paused = true`. This happens when the server-side device/token state is gone (worker redeploy with clean DO storage, dev state purge, new subdomain). Nothing ever rotates tokens, and `AccountDO.registerDevice` (`worker/src/durable-objects/AccountDO.ts:169-172`) returns `409 device already registered` for an existing deviceId — so recovery requires the full disconnect→re-setup flow, which then replays history and re-triggers S2. Matches "mobile disconnected on its own and I had to log in again".

### S4. Server commits conflict copies even for identical content
`VaultSyncDO.detectConflict` (`worker/src/durable-objects/VaultSyncDO.ts:352-385`) compares only `pathRev > baseRevision`, never the payload. Re-uploads of the *same bytes* (seed races, reconnect echoes, S1 cascades) are treated as conflicts: `commitCopy` (`VaultSyncDO.ts:437-455`) writes a new `create` for `x (conflict-…).md` as a new revision, which then materializes on **every** device via the next pull. "A lot of duplicate files even when there are 0 conflicts".

### S5. Remote-apply failure policy pauses on any benign race
The pause-on-error in `applyRemoteChange` is too broad. Already-applied changes (source gone, dest present), occupied rename targets, and folder/file collisions are all benign races that should not stop sync.

### S6. Mobile hangs kill polling/uploading (no timeouts)
`SyncClient.request` (`plugin/src/api/SyncClient.ts:83-107`) never passes a `timeout` to Obsidian's `requestUrl`. If a pull never settles (mobile backgrounding/suspend), `pollOnce.polling` stays `true` forever (`SyncEngine.ts:159-190`) and every later poll returns early → sync stops silently until the app restarts. A hung push similarly stalls the flush loop.

### S7. 60s watcher suppression swallows real edits
`VaultWatcher.suppress`/`isSuppressed` (`plugin/src/vault/VaultWatcher.ts:92-102, 183-191`) keeps a path suppressed for 60 seconds; a genuine user edit to the same path within that window is silently dropped from the queue → upload never happens → divergence → later false conflicts. Obsidian fires vault events within milliseconds of adapter calls, so 60s is pure risk.

### S8. HTTP catch-up is limited to 100 revisions per poll
`pollOnce` applies a single batch and stops; catching up a long history takes `n/100` polls. Non-fatal, fixed by the S1 converge loop.

### S9. `resync_required` dead-end (documented V1 limitation, not random)
A device behind the retained history can push but never pull; no recovery except rebuild. Keep the behavior, soften the notice spam.

## Fix plan

### F1 — Cursor only advances per applied change (S1, S8)
- Remove `setLastRevision(result.revision)` from `flushQueue` on accept for the HTTP transport. Cursor advancement lives solely in `applyRemoteChange` (applied in revision order).
- Add `advanceCursorOnAccept: boolean` to the `Connection` interface: `HttpConnection` → `false`, `SyncConnection` → `true` (WS is ordering-safe: broadcasts are sent before the pusher's own `accepted` reply on the same FIFO socket).
- `pollOnce` loops pull→apply→(flush)→pull until `pull` returns no new changes (safety cap ~10 iterations). Interleaved and self-pushed revisions are then applied in order; self-pushed re-application is safe once F2 makes apply idempotent.

### F2 — Robust, idempotent, non-fatal apply (S2, S3, S5)
- `VaultOps.rename` (`main.ts`):
  - Source missing + destination exists → already-applied → skip silently (no throw, no pause).
  - Source missing + destination missing → notify once, skip.
  - Source and destination both exist (occupied destination) → back up the existing destination bytes to a fresh `(conflict-…).md` copy first, then rename (per plan §5 "preserve the existing destination"). **Default: back-up-then-rename.**
- `SyncEngine.applyRemoteChange`: benign cases (skipped/backed-up applies) → ACK + advance cursor, no pause; pause only for fatal local errors (disk full, invalid payload).
- `SyncState.disconnect()`: preserve `lastRevision`/`seeded`/`appliedPaths` on a plain disconnect; only the Rebuild/Join flows reset the cursor. A re-login via token rotation (F3) then keeps the device cursor → no full history replay → the S2 loop cannot re-trigger.

### F3 — Token rotation + self-healing auth (S3)
- `AccountDO.registerDevice`: if the deviceId already exists **for the same account + vault**, rotate the token (update `token_hash`, return a new `deviceToken`) instead of failing with `409`. This makes "log in again" seamless: same device identity, same cursor, new token.
- Plugin `AuthManager.existingUser`: re-registration via the existing flow now rotates the token; add a Settings "Reconnect vault" button that runs password-only re-registration without resetting state.
- `handleAuthFailure`: pause only after 3 consecutive 401s (not the first), rate-limit the notice so a broken server-side state does not hammer or spam.

### F4 — Identical-content dedupe on the server (S4)
- In `VaultSyncDO.submitChange` / `detectConflict`: when an upsert "conflicts" by revision, fetch the change at `pathRev` (`getChangeByRevision`); if it is a create/update with the **same payload**, treat it as accepted — record the receipt, return `{status: "accepted"}`, commit **no** new revision and **no** conflict copy. Different content → existing conflict-copy behavior unchanged.

### F5 — Timeouts on all HTTP calls (S6)
- `SyncClient.request` passes `timeout` to Obsidian's `requestUrl` (supported option). Timeouts and non-2xx both raise; `pollOnce`'s `finally` then clears `polling` and cannot deadlock.

### F6 — Shrink suppression TTL (S7)
- Lower `SUPPRESS_TTL_MS` from 60s to ~3s (Obsidian events fire synchronously after adapter calls; suppression remains effective, real edits stop being swallowed).

## Files touched

| File | Change |
|---|---|
| `plugin/src/sync/SyncEngine.ts` | cursor fix (F1), converge loop (F1), benign-apply no-pause (F2), 401 backoff (F3) |
| `plugin/src/sync/SyncConnection.ts` | `advanceCursorOnAccept` on `Connection` (F1) |
| `plugin/src/sync/HttpConnection.ts` | `advanceCursorOnAccept = false` (F1) |
| `plugin/src/main.ts` | robust rename/write ops (F2) |
| `plugin/src/state/SyncState.ts` | preserve cursor on disconnect (F2) |
| `plugin/src/api/SyncClient.ts` | request timeouts (F5) |
| `plugin/src/vault/VaultWatcher.ts` | suppression TTL (F6) |
| `plugin/src/ui/SettingsTab.ts` | "Reconnect vault" button (F3) |
| `plugin/src/auth/AuthManager.ts` | token-rotation-aware re-register (F3) |
| `worker/src/durable-objects/AccountDO.ts` | registerDevice token rotation (F3) |
| `worker/src/durable-objects/VaultSyncDO.ts` | identical-content dedupe (F4) |

## Tests

- **Worker** (`mutations.test.ts` / `core.test.ts`):
  - Re-registering an existing device for the same vault rotates the token; old token rejected, new token works.
  - Stale upsert with identical payload → `accepted`, no conflict copy, log size unchanged.
  - Stale upsert with different payload → conflict + copy (existing tests stay green).
- **Plugin** (`SyncEngine.test.ts`):
  - HTTP push-accept does not advance the cursor past interleaved remote revisions; converge loop applies them (multi-batch).
  - Rename onto an occupied destination → destination backed up, rename applied, sync not paused.
  - Already-applied rename (source gone, dest present) → no pause, cursor advances.
  - `advanceCursorOnAccept` honored per transport.
- **Watcher** (`VaultWatcher.test.ts`): suppression expires after the short TTL.
- Run `npm run test` (plugin 41 + worker 17) and `cd plugin && npm run build`.

## Out of scope

- `phase2.md` (theme/snippet sync) — separate feature, untouched.
- Full resync for `resync_required` (S9) — documented V1 limitation.
- WS transport redesign — benefits from shared fixes; HTTP is the default/observed transport.
