# Build: Obsidian Sync

> **Current policy supersession:** conflict-preservation requirements in this
> historical build plan are superseded by `conflict-removal-plan.md`. The
> implementation target is server-revision last-write-wins. Existing
> `conflict-*` files remain untouched; no new conflict files may be created.

Build a production-oriented Obsidian synchronization service that synchronizes an Obsidian vault between desktop and mobile.

The project must be designed around an always-online cloud backend.

The user's laptop and phone are CLIENTS only. The synchronization backend must never depend on either device remaining online.

Use:

* TypeScript for the Obsidian plugin
* Cloudflare Workers for the API
* Cloudflare Durable Objects for per-vault synchronization state and serialization
* Cloudflare R2 for file/blob storage
* Durable Object SQLite storage for synchronization metadata
* Wrangler for deployment

Do NOT use a VPS.
Do NOT use a server process that must remain running on the user's laptop.
Do NOT use a traditional Node server in production.
Do NOT use Turso in V1.
Do NOT use Postgres in V1.
Do NOT use Redis in V1.

The architecture must be capable of scaling to many independent vaults and devices.

---

# 1. Repository

Create:

```text
obsidian-sync/
├── plugin/
│   ├── src/
│   │   ├── main.ts
│   │   ├── settings.ts
│   │   ├── api/
│   │   │   └── SyncClient.ts
│   │   ├── sync/
│   │   │   ├── SyncEngine.ts
│   │   │   ├── ChangeQueue.ts
│   │   │   ├── ConflictResolver.ts
│   │   │   └── types.ts
│   │   ├── storage/
│   │   │   └── LocalState.ts
│   │   ├── hashing/
│   │   │   └── hash.ts
│   │   └── ui/
│   │       ├── SettingsTab.ts
│   │       ├── StatusBar.ts
│   │       └── ConflictView.ts
│   ├── manifest.json
│   └── package.json
│
├── worker/
│   ├── src/
│   │   ├── index.ts
│   │   ├── auth.ts
│   │   ├── router.ts
│   │   ├── types.ts
│   │   └── durable-objects/
│   │       └── Vault.ts
│   ├── wrangler.jsonc
│   ├── package.json
│   └── migrations/
│
├── README.md
└── package.json
```

Use TypeScript throughout the Cloudflare backend.

Use the official Cloudflare Workers APIs and bindings.

---

# 2. Cloudflare architecture

The production topology is:

```text
Obsidian Desktop
       │
       │ HTTPS
       ▼
Cloudflare Worker
       │
       ├──────────────► R2
       │                blobs
       │
       └──────────────► Durable Object
                         │
                         ├── vault metadata
                         ├── device state
                         ├── file metadata
                         ├── revisions
                         └── change log

Obsidian Mobile
       │
       │ HTTPS
       ▼
Cloudflare Worker
       │
       └──────────────► same Vault Durable Object
```

There must be no central in-memory synchronization state in the Worker.

Workers must be stateless.

The Durable Object is authoritative for synchronization state.

---

# 3. Durable Object partitioning

Create exactly one logical Durable Object per vault.

Use:

```text
vaultId
```

as the Durable Object identity.

Conceptually:

```text
vault-A → VaultDO(A)
vault-B → VaultDO(B)
vault-C → VaultDO(C)
```

A vault's synchronization operations must be serialized through its Durable Object.

This is the core consistency mechanism.

Do not implement distributed locks.

Do not implement Redis locks.

Do not implement application-level leader election.

---

# 4. Durable Object state

Use SQLite-backed Durable Object storage.

Store:

```text
vault
devices
files
changes
```

Schema:

```sql
CREATE TABLE files (
    path TEXT PRIMARY KEY,
    sha256 TEXT,
    size INTEGER,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    blob_key TEXT,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE changes (
    revision INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    operation TEXT NOT NULL,
    sha256 TEXT,
    size INTEGER,
    blob_key TEXT,
    device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
);
```

Maintain:

```text
currentRevision
```

for each vault.

Every committed mutation increments the vault revision.

---

# 5. R2

Use R2 for actual file contents.

Do NOT store Markdown, images, PDFs, audio, or other vault file contents inside Durable Object SQLite.

Use content-addressed storage:

```text
vaults/<vaultId>/blobs/<sha256>
```

The SHA-256 hash is the content identity.

If two files have identical contents, they should reference the same R2 object.

Do not upload duplicate blobs.

Support arbitrary binary files.

Do not assume everything is UTF-8 text.

---

# 6. Worker API

Implement:

```text
GET  /health

POST /v1/vaults
POST /v1/vaults/:vaultId/devices

GET  /v1/vaults/:vaultId/sync?since=<revision>

PUT  /v1/vaults/:vaultId/blobs/:sha256

GET  /v1/vaults/:vaultId/blobs/:sha256

POST /v1/vaults/:vaultId/changes
```

All vault endpoints require authentication.

---

# 7. Authentication

V1 uses bearer tokens.

Header:

```text
Authorization: Bearer <token>
```

Generate a random high-entropy token when a device is registered.

Do not implement OAuth in V1.

Do not implement passwords in V1.

Do not implement social login.

Design the authentication layer so OAuth/account authentication can be added later.

Never log authentication tokens.

---

# 8. Change model

A client change has:

```json
{
  "deviceId": "device-123",
  "path": "DSA/Binary Search.md",
  "operation": "upsert",
  "sha256": "abc123",
  "size": 1234,
  "baseRevision": 41
}
```

Operations:

```text
upsert
delete
rename
```

For rename:

```json
{
  "operation": "rename",
  "oldPath": "old.md",
  "newPath": "new.md",
  "baseRevision": 41
}
```

---

# 9. Synchronization semantics

The server is authoritative.

Every successful mutation produces a monotonically increasing revision.

Example:

```text
revision 41
revision 42
revision 43
revision 44
```

A device stores:

```text
lastSyncedRevision = 41
```

It can request:

```text
GET /sync?since=41
```

and receive revisions:

```text
42
43
44
```

The device applies those changes and advances its cursor.

---

# 10. Push semantics

When a device sends a mutation:

```text
baseRevision = N
```

the Durable Object must determine whether the target path has changed since N.

If it has not changed:

```text
ACCEPT
```

Commit the mutation and allocate the next revision.

If the target path changed after N:

```text
CONFLICT
```

Do not overwrite the server's canonical version.

Return:

```json
{
  "status": "conflict",
  "path": "...",
  "serverRevision": 42,
  "serverHash": "...",
  "serverBlobKey": "..."
}
```

---

# 11. Historical conflict policy (superseded)

The original conflict-preservation policy below is retained as project history
only. It is not the current implementation target. The active policy is
documented in `conflict-removal-plan.md`: valid mutations use server-revision
last-write-wins, existing conflict-named files remain untouched, and no new
conflict files are created.

V1 must NOT attempt automatic Markdown merging.

When the plugin receives a conflict:

1. Keep the local file contents.
2. Download the server version.
3. Save the server version as the canonical original.
4. Save the local contents as a conflict copy.

Example:

```text
DSA/Binary Search.md

DSA/Binary Search (conflict-mobile-20260812-1430).md
```

Never silently destroy either version.

---

# 12. Plugin

The plugin must be:

```json
{
  "isDesktopOnly": false
}
```

Use Obsidian's Vault API.

Do not use:

```text
fs
path
electron
Node filesystem APIs
```

The same plugin must run on desktop and mobile.

Use Obsidian's supported HTTP request APIs rather than assuming browser `fetch` behavior.

---

# 13. Vault events

Listen for:

```text
create
modify
delete
rename
```

Convert events into a local persistent queue.

Debounce rapid modify events.

Do not perform network requests directly inside the event handlers.

Use:

```text
event
 ↓
queue
 ↓
sync engine
```

---

# 14. Local queue

The queue must survive:

* Obsidian restart
* device restart
* temporary network failure
* server failure
* app suspension

Each queued operation should contain:

```text
id
operation
path
oldPath
sha256
size
baseRevision
createdAt
status
attempts
```

Never delete a queue item until the server has acknowledged it.

---

# 15. Sync algorithm

Implement:

```text
SYNC
 │
 ├── acquire local sync lock
 │
 ├── PULL remote changes
 │
 ├── apply remote changes
 │
 ├── process local pending queue
 │
 ├── upload missing blobs
 │
 ├── commit mutations
 │
 ├── handle conflicts
 │
 ├── update revision cursor
 │
 └── release sync lock
```

Only one sync operation may execute at a time on a device.

---

# 16. Remote-change suppression

Applying a remote change to the Obsidian vault will trigger Vault events.

Those events must NOT be interpreted as new local edits.

Implement robust suppression.

Do not rely only on a global boolean if asynchronous operations make that unsafe.

Track paths currently being modified by the sync engine and suppress matching events until the operation completes.

---

# 17. Offline-first behavior

The plugin must work when the network is unavailable.

Example:

```text
edit note
   ↓
local queue
   ↓
network unavailable
   ↓
continue working normally
   ↓
network returns
   ↓
sync
```

No user edit may be lost because the server is unavailable.

---

# 18. Initial synchronization

When a new device joins a vault:

```text
device registration
       ↓
initial sync
       ↓
download all current files
       ↓
set cursor = currentRevision
```

The plugin must not emit uploaded changes for files it is applying during initial synchronization.

---

# 19. File types

V1 should synchronize all normal vault files:

```text
.md
.canvas
.excalidraw
.png
.jpg
.jpeg
.gif
.webp
.svg
.pdf
.mp3
.mp4
webm
etc.
```

Do not restrict synchronization to Markdown.

However, do NOT synchronize:

```text
.obsidian/
```

in V1.

Do not sync:

```text
workspace
community plugins
themes
plugin settings
```

Keep `.obsidian` synchronization as a future feature.

---

# 20. Blob optimization

Before uploading a file:

```text
SHA-256(content)
```

Check whether the blob already exists.

If it exists:

```text
skip upload
```

and simply reference the existing blob.

If it does not exist:

```text
upload blob
```

then commit the metadata mutation.

Never commit a metadata record pointing to a blob that has not successfully been stored.

---

# 21. Large files

Do not load unnecessarily large files entirely into memory.

Design the blob-upload layer so it can later support multipart/resumable uploads.

V1 can impose a configurable maximum file size.

Return a clear error when the limit is exceeded.

---

# 22. WebSockets

Do NOT implement WebSockets initially.

The first version uses polling:

```text
every 30 seconds
```

and:

```text
Sync now
```

manual synchronization.

However, structure the backend so realtime WebSocket connections can later be attached to the Vault Durable Object.

Future architecture:

```text
Desktop ───── WebSocket ────┐
                            │
                         VaultDO
                            │
Mobile ────── WebSocket ────┘
```

---

# 23. Security

Validate every path.

Reject:

```text
../
absolute paths
null bytes
invalid path encodings
```

Normalize paths before storage.

Prevent path traversal.

Validate SHA-256 format.

Validate file size.

Never trust client-provided metadata blindly.

Never log file contents.

Never log tokens.

Use HTTPS in production.

---

# 24. V1 UI

Plugin settings:

```text
Server URL
Vault ID
Device ID
Device Name
Authentication Token
Auto Sync
Sync Interval
```

Commands:

```text
Sync now
Show sync status
Show conflicts
Pause sync
Resume sync
```

Status bar:

```text
✓ Synced
↻ Syncing
↑ Uploading
↓ Downloading
⚠ Conflict
✕ Offline
```

Keep UI minimal.

---

# 25. Cloudflare configuration

Create a Wrangler configuration containing bindings for:

```text
R2 bucket
Vault Durable Object
```

Use SQLite-backed Durable Objects.

Use environment variables/secrets for sensitive configuration.

Never commit secrets.

Provide:

```text
npm run dev
npm run deploy
```

commands.

---

# 26. Local development

Local development must use:

```text
Wrangler
local Worker
local Durable Objects
local R2
```

Do not require a VPS.

The Obsidian plugin should point to:

```text
http://localhost:8787
```

during development.

Production should point to:

```text
https://sync.<domain>
```

---

# 27. Testing

Write tests for:

### Basic sync

```text
desktop creates file
→ server
→ mobile receives file
```

### Modification

```text
desktop modifies
→ mobile receives updated content
```

### Delete

```text
desktop deletes
→ mobile deletes
```

### Rename

```text
desktop renames
→ mobile renames
```

### Offline

```text
device offline
→ edit
→ queue
→ reconnect
→ sync
```

### Conflict

```text
desktop and mobile both start from revision 41

desktop → revision 42

mobile → based on 41

server → conflict
```

### Duplicate blobs

Two files with identical SHA-256 must use one R2 object.

### Remote event suppression

Applying a remote change must not enqueue a new local mutation.

### Crash recovery

Kill/restart the plugin while a queue contains changes.

The changes must still be present after restart.

### Pagination

The pull endpoint must correctly handle large change logs.

---

# 28. Important scalability rule

Never scan an entire vault on every sync.

Never send the entire vault to the server.

Use:

```text
revision cursor
```

to request only changes since the client's last known revision.

For example:

```text
client cursor = 12043

GET /sync?since=12043

server:
12044
12045
12046
...
```

Add pagination:

```text
limit=500
```

so a device catching up after months offline does not receive an unbounded response.

---

# 29. Architecture invariants

These are non-negotiable:

1. The cloud backend is independent of client devices.
2. A vault has exactly one logical synchronization authority.
3. All mutations for a vault are serialized through its Durable Object.
4. R2 stores file contents; Durable Object storage stores synchronization metadata.
5. Clients can work offline.
6. Local changes are never discarded before server acknowledgement.
7. Server conflicts never silently overwrite data.
8. Remote file application never generates a new upload.
9. Sync uses revision cursors instead of full-vault scans.
10. The server never needs the user's laptop to be online.
11. V1 does not synchronize `.obsidian`.
12. V1 does not require Turso, Postgres, Redis, or a VPS.

---

# 30. Implementation order

Implement in this exact order:

## Step 1

Create the Obsidian plugin skeleton.

Verify it loads on desktop.

## Step 2

Make the plugin load on mobile.

## Step 3

Implement Vault event handling.

## Step 4

Create the Cloudflare Worker.

Implement:

```text
GET /health
```

## Step 5

Create the Vault Durable Object.

Implement vault creation.

## Step 6

Create R2 binding.

Implement blob upload/download.

## Step 7

Implement revision-based change log.

## Step 8

Implement pull synchronization.

## Step 9

Implement push synchronization.

## Step 10

Implement local persistent queue.

## Step 11

Implement offline synchronization.

## Step 12

Implement conflict detection.

## Step 13

Implement conflict copies.

## Step 14

Implement settings/status UI.

## Step 15

Test desktop ↔ desktop.

## Step 16

Test desktop ↔ mobile.

## Step 17

Deploy to Cloudflare.

Only after all of this consider:

* WebSockets
* end-to-end encryption
* accounts
* OAuth
* `.obsidian` synchronization
* version history
* snapshots
* sharing
* billing

---

# 31. Do not over-engineer

The objective is NOT to build a competitor to Obsidian Sync today.

The objective is:

```text
Obsidian Desktop
       ↕
Cloudflare
       ↕
Obsidian Mobile
```

with reliable offline synchronization.

Get this working first.

When implementing, prefer simple explicit code over abstraction-heavy architecture.

If an Obsidian API is uncertain, consult the current official Obsidian documentation rather than guessing.

If a Cloudflare API is uncertain, consult the current Cloudflare Workers/Durable Objects/R2 documentation rather than guessing.

Start writing the implementation immediately. Do not only produce an architecture document.
