# SyncVault implementation plan

## Product outcome

A user installs SyncVault, creates an account or signs in on another device, chooses the vault once, and sync runs automatically. Normal transient failures recover silently. When a real conflict occurs, no bytes are lost; SyncVault preserves a clearly named conflict copy. Themes and selected appearance synchronize by default.

The only unavoidable exception is a device offline beyond the seven-day temporary-history window: because SyncVault is not a backup service, recovery must ask which device is authoritative. That flow remains one guided action, not a collection of troubleshooting steps.

## Protocol, storage, and server correctness

- Replace the inline `payload` transport with a versioned content reference:
  - `Change` gains `content: { hash, byteLength, chunkCount }` for creates/updates and `causalParents?: string[]` for ordered local mutation chains.
  - Upload uses begin → fixed 256 KiB chunks → verified complete. The server commits and broadcasts only after all chunks match the declared SHA-256 and byte count.
  - Download fetches chunks by revision and verifies the hash before local application.
  - Support up to 16 MiB per file, including theme assets; larger files remain local and produce one clear notice. Chunking avoids the Durable Object SQLite 2 MB row limit while keeping all data temporary. [Cloudflare Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
  - Incomplete uploads expire after 24 hours; the persisted local queue retries them safely.

- Add an atomic `syncSince(deviceId, cursor, capabilities)` Durable Object operation. It validates the cursor, records the device heartbeat, returns the retention state and one ordered batch from a single consistent read. Remove the current separate status/read race.

- Cursor rules:
  - Only an applied remote revision advances the persisted cursor and is ACKed.
  - HTTP push acceptance never advances the cursor.
  - A sync round: flush pending local filesystem observations → pull/apply until empty (ten-batch cap) → upload queue → pull again until self and interleaved revisions are consumed.
  - If the cap is reached, retain “Syncing” and schedule an immediate continuation; never show a false “Synced.”
  - WebSocket callbacks must serialize `accepted` behind every preceding remote application before allowing its cursor optimization.

- Reject both pull and push from a cursor/base revision older than the retained-history floor with `RESYNC_REQUIRED`; preserve the local queue and enter a stable recovery state. Never drop queued changes merely because the server returned a 4xx.

- Prevent sequential local actions from conflicting with themselves:
  - Replace the destructive path coalescer with an ordered reducer that preserves rename/write/delete dependencies.
  - Keep the original base revision; never blindly rebase it after an accepted upload.
  - Send direct causal parent operation IDs for paths changed by the same pending chain. The server permits a stale path only when its current state is exactly one of those declared same-device parents; unrelated remote changes still conflict.
  - Examples that must work: update → rename, rename → update, delete target → rename into target, folder rename expansion, and restart mid-chain.

- Persist `content_hash` and `last_operation_id` in server path state. A stale create/update with an identical live-content hash records a receipt and returns accepted without adding a revision or conflict copy. Different content keeps the existing conflict-copy behavior.

- Make server retention actually bounded and safe:
  - Schedule the Durable Object alarm on vault initialization and commits.
  - Clamp ACKs to `currentRevision`; reject malformed revisions.
  - Heartbeat devices on HTTP pull, push, ACK, and WebSocket activity.
  - Purge change chunks and operation receipts together once all active devices ACK or after seven days.
  - Purge deleted-path tombstones once no retained device can reference them; retain only metadata for currently live files.
  - Translate storage-full failures to `INSUFFICIENT_STORAGE`, preserving the client queue for retry rather than losing changes.

- Strictly validate operation IDs, revision/base values, paths, content descriptors, chunk indexes, hashes, and protocol capability. Keep legacy inline-payload support during migration; if a device cannot understand a chunked revision, return `CLIENT_UPGRADE_REQUIRED` before sending unsupported data.

## Local reliability and file safety

- Store pending file content as durable staged files under the plugin’s own excluded data directory, not inside plugin settings JSON. Persist only queue metadata, checksums, dependencies, and staging references.

- Make local capture crash-safe:
  - Snapshot bytes to a temporary staging file, atomically promote it, then atomically persist queue metadata.
  - Serialize all state mutations so queue writes, cursor updates, seeded markers, visual snapshots, and recovery changes cannot overwrite one another.
  - On startup, reconcile incomplete staging/metadata pairs before syncing.
  - Migrate existing queued inline payloads to staged files before removing legacy fields.

- Add an applied-operation journal around remote filesystem mutations. If the app crashes after the filesystem write but before cursor persistence, retrying the same revision becomes provably idempotent rather than guessing from path existence.

- Before applying any remote change, flush and persist pending local observations for affected paths. This prevents a just-edited local file from being overwritten before its pre-overwrite bytes enter the durable queue.

- Replace broad time suppression with expected-operation suppression:
  - Record the expected path, operation, and content hash before a remote write.
  - Consume only matching follow-up filesystem events.
  - A different event or content hash is a real local edit and is queued immediately.
  - Expire stale expectations quickly without suppressing user work.

- Apply remote changes safely:
  - Missing delete targets are successful no-ops.
  - A rename retry is a no-op only when its applied-operation journal proves it previously completed.
  - An occupied rename target is copied to a unique local conflict file, deliberately queued for sync, then replaced by the remote rename.
  - File-vs-folder ancestor collisions preserve the blocking local file as a queued conflict copy before creating required folders.
  - Ambiguous missing-source renames, invalid data, unreadable paths, and storage errors are never ACKed; enter the one actionable paused/recovery state.

- Treat the protocol as file-only. Expand local folder renames and deletes into ordered per-file operations using a persisted local file manifest; ignore raw folder operations. This prevents a folder event from corrupting server path state.

- Add a cross-platform collision key for paths (normalized Unicode plus deterministic case-insensitive form). The server detects `Foo.md`/`foo.md` collisions before they reach a case-insensitive device. Preserve the second version as a deterministic conflict copy; use a temporary path for case-only renames where required.

## Authentication, recovery, and user experience

- Keep explicit **Disconnect vault** as an unlink action that removes identity and local sync association.

- Add **Reconnect vault** as the only credential-recovery action:
  - Ask for the account password only.
  - Re-registering the same account, vault, and device ID rotates its token.
  - Preserve cursor, queue, staging files, applied-operation journal, and visual state.
  - Existing device IDs belonging to another account or vault remain rejected.

- Do not pause on the first two 401 responses. Reset the counter after any authenticated success; after three consecutive 401s, pause once and show Reconnect vault. Network timeouts and server 5xx errors remain retryable offline states.

- Wrap every HTTP request in a deadline so suspended mobile requests cannot lock polling or uploads forever. Late results are harmless because operations are idempotent and receipt-backed.

- Replace separate rebuild/join troubleshooting with one **Recover sync** guide:
  - Explain that history is temporary and identify the device with the complete vault.
  - “Use this device as the new baseline” requires the password, preserves a local recovery snapshot before resetting server history, then reseeds.
  - Other devices choose “Join recovered vault”; their local files are preserved as conflict copies where necessary.
  - Do not clear a queue or cursor until the server reset succeeds.

## Visual synchronization

- Enable one setting, **Sync visual appearance**, by default for new and migrated vaults. It includes:
  - theme folders;
  - selected appearance settings.
  - It excludes CSS snippets, plugins, plugin data, workspace state, hotkeys, caches, and every other Obsidian configuration file.

- Represent visual files under a reserved logical sync namespace rather than the literal `.obsidian` path. Map it to each device’s actual `vault.configDir` locally, so devices using different configuration-directory names remain compatible.

- Add a visual scanner independent of Obsidian’s loaded-vault file list:
  - scan themes and appearance on startup, manual sync, and a low-frequency foreground interval;
  - compare stat snapshots, hash only changed files, and detect deletions;
  - seed visual content once without reseeding normal vault files;
  - apply appearance only after all theme changes in that convergence round complete.

- After applying visual files, wait for Obsidian’s appearance-refresh signal. If the platform does not refresh automatically, retain the synced state and show one passive “Theme will apply after restarting Obsidian” status rather than retrying or changing unrelated settings.

- If the single visual setting is disabled later, stop uploading visual changes and advance past incoming visual revisions without writing them locally. Normal vault synchronization remains unaffected.

## Verification and release gates

- Plugin unit/integration tests cover:
  - interleaved HTTP revisions, multi-batch convergence, WebSocket ordering, request deadlines, restart points, and serialized state writes;
  - every ordered queue chain and causal-parent validation path;
  - local-edit-versus-remote-apply races, conflict-copy preservation, file/folder collisions, case collisions, folder rename/delete expansion, and idempotent crash retries;
  - visual namespace mapping, theme asset chunking, appearance ordering, disabled visual policy, and configuration-directory differences;
  - token rotation, three-strike 401 behavior, and non-destructive recovery.

- Worker tests cover:
  - atomic pull state, heartbeat/GC behavior, ACK bounds, alarm scheduling, receipt/chunk cleanup, stale-write rejection, content dedupe, causal parent validation, capability upgrade errors, and storage-full handling.

- Add deterministic end-to-end fixtures with two simulated devices, restart injection after every local/remote persistence boundary, offline edits, competing edits, rename chains, and a theme containing nested assets.

- Release as a protocol feature version with compatibility gating. CI must run the root test suite, Worker test runtime, type checks, and production plugin build successfully before packaging. Test desktop and Android with fresh setup, reconnect, offline recovery, theme selection, and a seven-day-retention recovery simulation.

## Defaults locked

- Temporary unconsumed history retention: **7 days**.
- Maximum synchronized file size: **16 MiB**, transmitted resumably in chunks.
- Visual synchronization: **on by default**; themes plus selected appearance only.
- Conflict policy: **preserve both versions automatically whenever bytes are available**.
- SyncVault remains synchronization, not backup; erased or expired server history requires the single guided authoritative-device recovery flow.
