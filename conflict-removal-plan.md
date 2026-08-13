# Conflict Removal Plan

## Objective

Change SyncVault from conflict-preserving synchronization to server-revision
last-write-wins synchronization. Existing files whose names already contain
`conflict-` remain untouched. The implementation must not create any new
conflict files, conflict copies, or conflict protocol responses.

"Latest" means the mutation committed latest by the server for that vault.
Client timestamps are not used for ordering because device clocks are not
reliable.

## Product Behavior

- Every valid create, update, delete, and rename is accepted and assigned a
  new server revision.
- A later accepted mutation replaces the earlier path state.
- A stale `baseRevision` no longer causes a write to be rejected or copied.
- Existing conflict-named files are ordinary files and continue syncing.
- Existing conflict files are never renamed, deleted, merged, or cleaned up by
  this change.
- Remote writes overwrite local targets.
- Remote renames replace occupied destinations.
- File/folder path collisions are resolved in favor of the incoming revision.
- Recovery join overwrites local files with the rebuilt server baseline.
- Sync errors may still retry or pause, but they are not reported as file
  conflicts and never create a conflict copy.

## Protocol Changes

### Remove conflict results

Files:

- `shared/src/index.ts`
- `plugin/src/api/SyncClient.ts`
- `plugin/src/sync/SyncConnection.ts`
- `plugin/src/sync/HttpConnection.ts`
- `worker/src/index.ts`

Changes:

- Remove the `conflict` `ServerMessage` variant.
- Remove the `conflict` branch from `PushResult`.
- Remove `ConnectionCallbacks.onConflict`.
- Remove HTTP and WebSocket conflict-response handling.
- Make normal push and chunk-completion responses return only `accepted`.
- Remove the `CONFLICT` route error mapping used only for conflict-path
  allocation.

Keep `baseRevision` and `causalParents` in the wire and persisted types for
one migration-safe release. They may continue to be validated, but they must
not be used to reject a valid mutation or generate a copy.

## Worker Changes

File: `worker/src/durable-objects/VaultSyncDO.ts`

### Replace `submitChange`

- Keep authentication, operation ID, path, content, payload, and storage
  validation.
- Keep operation-receipt lookup so retries remain idempotent.
- Remove the call to `detectConflict`.
- Commit every valid mutation through `commit`.
- Return the committed revision as `accepted`.
- Do not compare `pathState.last_revision` with `change.baseRevision` for
  conflict purposes.

### Remove conflict-only functions

Remove:

- `detectConflict`
- `commitCopy`
- `freshConflictPath`
- `collisionPath`

Keep existing `path_state` columns during the first release for Durable Object
storage compatibility. `last_operation_id`, `content_hash`, and
`collision_key` may remain populated until a later storage cleanup migration,
but no conflict behavior may depend on them.

### Replace `completeUpload`

- Preserve chunk count and SHA-256 verification.
- Submit the verified change using the new unconditional commit path.
- Return `accepted` for both fresh and previously stale uploads.
- Store the uploaded chunks under the committed revision as today.
- Never create a conflict revision or conflict path.

## Plugin Transport Changes

### `SyncClient`

File: `plugin/src/api/SyncClient.ts`

- Change `PushResult` to the accepted result only.
- Preserve retry, authentication, upload, and download errors.
- Do not expose a conflict-path field to the engine.

### `HttpConnection`

File: `plugin/src/sync/HttpConnection.ts`

- Remove the result branch that calls `onConflict`.
- Resolve accepted acknowledgements for every valid server commit.
- Keep 401, retry, rejection, resync, and network-error handling.

### `SyncConnection`

File: `plugin/src/sync/SyncConnection.ts`

- Remove `onConflict` from `ConnectionCallbacks`.
- Remove conflict handling from `uploadAndAnnounce`.
- Remove the incoming WebSocket `conflict` case.
- Keep ordered remote delivery, accepted acknowledgements, and stale-socket
  protection.

## Plugin Engine Changes

File: `plugin/src/sync/SyncEngine.ts`

### Queue acknowledgement

- Remove the conflict member from `AckResult`.
- Remove conflict callback wiring from the constructor.
- Make `flushQueue` remove every accepted item normally.
- Remove conflict status transitions caused by server responses.
- Rename or simplify `removeDropped` in `ChangeQueue` so it is used only for
  permanent rejection cleanup, not conflict-copy handling.

### Remove local conflict-copy functions

Remove:

- `enqueueConflictCopy`
- `freshLocalConflictPath`
- `backupIfDivergent`
- `enterJoinMode`
- `joinBackup`

Change `enqueueVisualChange` so large visual files are staged and queued at
their original logical path rather than routed through a conflict-copy helper.

### Remote content writes

Replace `ensureNoBlockingFile` with incoming-write path preparation:

- Walk ancestors of the incoming path.
- If an ancestor is a file where a folder is required, remove that file.
- Create the required folders.
- Never preserve the removed file under another name.

Remote create/update writes continue to use watcher expectations, then replace
the target bytes unconditionally.

### Remote renames

Update `applyRename`:

- If the destination is occupied, remove it first.
- Apply the incoming rename.
- Keep idempotent handling for journal-proven operations.
- Keep case-only rename temporary-path handling where required by the
  filesystem.
- Do not read, preserve, enqueue, or name a conflict copy.

### Status behavior

- Remove `conflict` from `SyncStatus` and the status-bar labels.
- Use `syncing` while a recoverable apply error is retrying.
- Use `paused` only for fatal apply/auth/recovery conditions requiring action.
- Replace any conflict-specific notices with explicit retry or paused-error
  notices.

## Recovery Changes

Files:

- `plugin/src/ui/RecoverModal.ts`
- `plugin/src/ui/SettingsTab.ts`

- Remove the `enterJoinMode` callback and `joinBackup` flow.
- Update the join description to say that the rebuilt baseline overwrites
  local files.
- Keep password confirmation and the syncable-file safety check.
- Keep existing conflict-named files as normal files; do not clean them up.

## Tests

### Worker tests

Update `worker/test/core.test.ts`, `worker/test/http.test.ts`, and
`worker/test/uploads.test.ts`:

- Replace stale-write conflict expectations with accepted last-write-wins
  expectations.
- Verify a stale different-content update commits the newest revision.
- Verify no conflict path or extra copy revision is returned.
- Verify stale chunked uploads are accepted and downloadable.
- Verify retries still resolve through operation receipts.
- Verify path and file/folder mutations remain serial and deterministic.

### Plugin tests

Update existing transport and engine tests:

- Remove conflict callback and conflict-result assertions.
- Add two rapid local saves over HTTP and verify both converge without a copy.
- Add offline edits that reconnect in sequence and verify the last server
  commit wins.
- Verify remote writes overwrite an existing local file without creating a
  sibling file.
- Verify occupied rename destinations are removed and replaced.
- Verify file/folder ancestor replacement creates no backup.
- Verify recovery join overwrites divergent local bytes without a backup.
- Verify large visual files retain their original logical path.
- Verify existing `conflict-*` files remain ordinary synchronized files.

## Documentation Changes

Update:

- `implementation.md`
- `execution.md`
- `bugfix.md`
- `README.md`
- `phase2.md`
- Relevant conflict-policy sections in `plan.md` and `planfin.md`

Documentation must describe last-write-wins, server revision ordering, remote
overwrite behavior, and the fact that existing conflict files are not
automatically removed. Remove claims that SyncVault preserves both versions or
creates conflict copies.

## Verification and Release

Do not code or release until this plan is approved.

After implementation:

1. Run plugin tests, worker tests, type checks, and production builds.
2. Search source and active documentation for conflict-generation code and
   conflict-copy paths.
3. Run a Wrangler dry run, then deploy the worker.
4. Bump the plugin to the next feature version, proposed as `0.3.0`.
5. Build and package `release/syncvault-0.3.0/` and its zip archive.
6. Commit implementation and tests.
7. Commit the release package.
8. Tag `v0.3.0` and push `main` and the tag to GitHub.
