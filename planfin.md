Build an MVP called SyncVault: an Obsidian plugin that synchronizes an Obsidian vault between desktop and mobile.

IMPORTANT:
Do not overengineer this.

The core product is a SYNC MECHANISM, NOT a cloud backup service.

The actual Obsidian vault remains on each user's devices.

The cloud only coordinates devices and temporarily stores changes that have not yet been consumed.

DO NOT use:
- R2
- Postgres
- Turso
- Redis
- Kafka
- CRDTs
- peer-to-peer networking
- QR pairing
- permanent cloud vault storage
- permanent version history
- billing
- complex role systems
- OAuth
- a separate mobile application

Use:
- TypeScript
- Obsidian plugin API
- Cloudflare Worker
- one SQLite-backed Durable Object per vault
- WebSockets
- Wrangler

==================================================
ARCHITECTURE
==================================================

                         CLOUD
                 Cloudflare Worker
                        |
                        v
                Vault Durable Object
                        |
          temporary synchronization queue
                    /         \
                   /           \
                  v             v
             Desktop         Mobile
             Obsidian         Obsidian
                |                |
             local vault      local vault

The cloud must NOT permanently store the user's vault.

Each device owns its local Obsidian vault.

==================================================
IDENTITY MODEL
==================================================

There are exactly three important identifiers:

accountId
vaultId
deviceId

Account:
    accountId

Vault:
    vaultId
    accountId
    name

Device:
    deviceId
    accountId
    vaultId

Relationship:

Account
  |
  +-- Vault A
  |     +-- Desktop
  |     +-- Mobile
  |
  +-- Vault B
        +-- Desktop

The plugin installation must generate a unique deviceId.

The account must have a unique accountId.

A local Obsidian vault must be associated with exactly one vaultId for synchronization.

==================================================
FIRST-TIME USER FLOW
==================================================

When plugin is installed and enabled:

Show:

"Welcome to SyncVault"

[ Existing user ]
[ New user ]

New user:
    generate a random accountId
    create account
    create deviceId
    ask whether current Obsidian vault should be synced
    create a new remote vault
    save vaultId locally

Existing user:
    authenticate
    generate deviceId if this is a new installation
    fetch the user's vaults
    allow the user to select which remote vault the CURRENT Obsidian vault belongs to
    save vaultId locally

Do NOT use QR codes.

Do NOT implement device-to-device pairing.

Devices are linked through:
    accountId -> vaultId

==================================================
LOCAL VAULT ASSOCIATION
==================================================

The plugin is running inside the current Obsidian vault.

Persist local configuration containing:

accountId
vaultId
deviceId
lastRevision

Each local Obsidian vault must have independent SyncVault state.

If the user opens another vault, it must not accidentally use the previous vaultId.

==================================================
SYNC MODEL
==================================================

Use a monotonically increasing revision number PER VAULT.

Example:

revision 100
revision 101
revision 102
revision 103

Each change contains:

{
    operationId,
    revision,
    deviceId,
    path,
    operation,
    baseRevision,
    timestamp,
    payload
}

Supported operations:

create
update
delete
rename

Rename contains:
    oldPath
    newPath

==================================================
LOCAL CHANGE FLOW
==================================================

When Obsidian detects:

create
modify
delete
rename

the plugin creates a local Change object.

Do NOT immediately lose the change if the network fails.

Maintain a local pending queue.

The local queue must survive plugin restart.

Flow:

Obsidian change
    ↓
Change object
    ↓
local pending queue
    ↓
send to server
    ↓
server commits revision
    ↓
server acknowledges
    ↓
remove from local pending queue

==================================================
REMOTE CHANGE FLOW
==================================================

The plugin connects to the Vault Durable Object using WebSocket.

When another device creates a change:

Device A
    ↓
Worker
    ↓
VaultDO
    ↓
WebSocket
    ↓
Device B

Device B:
    1. receives change
    2. applies it to the local Obsidian vault
    3. advances lastRevision
    4. sends ACK

Remote changes MUST NOT be interpreted as new local changes.

Implement remote-change suppression so:

remote change
    ↓
write file
    ↓
Obsidian fires modify event
    ↓
plugin recognizes it is applying a remote operation
    ↓
DO NOT create another outbound change

Avoid infinite sync loops.

==================================================
DURABLE OBJECT
==================================================

Create:

class VaultSyncDO

Use SQLite-backed Durable Object storage.

There is one Durable Object instance per vault.

The Durable Object is responsible for:

- current revision
- temporary change queue
- connected devices
- acknowledgements
- conflict detection
- cleanup

Use persistent SQLite storage for state.

Do not rely on in-memory state because Durable Objects can restart/hibernate.

==================================================
DATABASE
==================================================

Inside each VaultSyncDO:

vault_state:

id
current_revision

devices:

device_id
last_seen
last_ack_revision

changes:

revision
operation_id
device_id
operation
path
old_path
base_revision
payload
timestamp

Add appropriate indexes.

operation_id must be unique.

If the same operationId is submitted twice, it must not create two changes.

==================================================
SYNC CURSOR
==================================================

Each client stores:

lastRevision

When reconnecting:

client says:

"I have revision 104."

Server returns all changes after 104.

Example:

client = 104
server = 108

return:

105
106
107
108

Client applies all changes and ACKs 108.

==================================================
WEBSOCKET
==================================================

Use a WebSocket connection for realtime synchronization.

When a device connects:

authenticate it
verify accountId/deviceId/vaultId
register the WebSocket
send any changes after the client's lastRevision

When a new change is committed:

broadcast it to all other connected devices in the same vault.

Use the Cloudflare Durable Object Hibernation WebSocket API where appropriate.

Automatically reconnect when:
- network disappears
- WebSocket closes
- Obsidian resumes
- device reconnects

After reconnect:
    perform catch-up using lastRevision.

==================================================
OFFLINE BEHAVIOR
==================================================

The plugin must work normally while offline.

If a user edits a file offline:

    modify local vault
    create pending change
    keep it locally

When network returns:

    reconnect
    upload pending changes
    catch up with remote changes

The user should never lose a local edit merely because the server is unavailable.

==================================================
CONFLICT DETECTION
==================================================

Use baseRevision.

Example:

Desktop and Mobile both have revision 100.

Desktop modifies A.md:
    baseRevision = 100

Mobile modifies A.md:
    baseRevision = 100

If Desktop commits first:
    server revision = 101

When Mobile submits:
    baseRevision = 100
    current server revision = 101

Detect conflict.

Do NOT silently overwrite either version.

For MVP:
    preserve the incoming conflicting version as:

A (conflict).md

Keep the implementation simple.

Do not implement CRDTs.

Do not implement automatic Markdown merging.

==================================================
TEMPORARY CLOUD STORAGE
==================================================

The cloud is NOT a backup.

Changes are temporary.

A change can be deleted when it is no longer required by the devices associated with the vault.

Track:

device_id
last_ack_revision

A change can be garbage-collected once every relevant active device has acknowledged it.

Also implement a maximum retention period, e.g. 7 days.

If a device has fallen behind beyond the retained history, return:

RESYNC_REQUIRED

Do not implement full resync in the first vertical slice.

Clearly separate this future feature from normal incremental sync.

==================================================
AUTHENTICATION
==================================================

For the MVP, implement the simplest reasonable account authentication.

Do not build OAuth.

Do not build complex sessions.

Do not build billing.

The important requirement is:

User A must not be able to access User B's vault.

Every request must validate:

accountId
vaultId
deviceId

against server-side state.

Never trust a client-provided accountId by itself.

==================================================
OBSIDIAN COMPATIBILITY
==================================================

The plugin must work on desktop and mobile.

manifest.json must have:

"isDesktopOnly": false

Use Obsidian's cross-platform APIs.

Do NOT use:
- Node fs
- Node path
- Electron-only APIs
- desktop-only filesystem watchers

Use the Obsidian Vault API/events.

==================================================
PLUGIN STRUCTURE
==================================================

Create:

src/
    main.ts

    auth/
        AuthManager.ts

    sync/
        SyncEngine.ts
        SyncConnection.ts
        ChangeQueue.ts
        ConflictManager.ts

    vault/
        VaultWatcher.ts

    state/
        SyncState.ts

    ui/
        SettingsTab.ts

==================================================
UI
==================================================

Keep UI minimal.

Settings page:

SyncVault

Account:
    user@example.com

Vault:
    My DSA Notes

Status:
    ✓ Synced

Device:
    Android

[ Sync Now ]

[ Disconnect Vault ]

First-time setup:

Welcome to SyncVault

[ New user ]
[ Existing user ]

New user:
    create account
    create synced vault

Existing user:
    login
    select existing vault

Do not build a web dashboard.

Do not build a fancy website.

==================================================
SECURITY
==================================================

For the first local prototype, payloads may be plaintext over HTTPS/WebSocket.

Before public beta, add end-to-end encryption.

Design the Change object so encryption can be inserted without redesigning the sync protocol.

Eventually:

local plaintext
    ↓
plugin encryption
    ↓
encrypted payload
    ↓
Cloudflare
    ↓
other device
    ↓
decrypt locally

The server should eventually never see plaintext vault contents.

==================================================
TESTING
==================================================

The FIRST working milestone is:

Obsidian Desktop
    ↕
Cloudflare Worker + VaultDO
    ↕
Obsidian Android

Test exactly this:

1. Create account on Desktop.
2. Create synced vault.
3. Install plugin on Android.
4. Login with same account.
5. Select the existing vault.
6. Desktop creates test.md.
7. Mobile receives test.md.
8. Mobile modifies test.md.
9. Desktop receives modification.
10. Turn Desktop network off.
11. Mobile modifies test.md.
12. Turn Desktop network on.
13. Desktop catches up.
14. Make conflicting edits on both devices.
15. Verify conflict is detected and neither version is silently lost.

Do not move to advanced features until this works.

==================================================
DEVELOPMENT
==================================================

Use:

npm run dev

for plugin development.

Use:

npx wrangler dev

for the Cloudflare Worker/Durable Object.

Provide:

npm run build
npm run test
npm run dev

The project must remain runnable after every implementation step.

==================================================
IMPLEMENTATION ORDER
==================================================

Implement ONLY these phases initially:

PHASE 1:
Obsidian plugin scaffold.
Plugin loads on desktop.

PHASE 2:
Plugin loads on mobile.
isDesktopOnly=false.

PHASE 3:
Account + device + vault identity.

PHASE 4:
Cloudflare Worker + VaultSyncDO.

PHASE 5:
WebSocket connection.

PHASE 6:
Desktop creates test.md.
Mobile receives it.

PHASE 7:
Mobile modifies test.md.
Desktop receives it.

PHASE 8:
Persistent local pending queue.

PHASE 9:
Offline catch-up.

PHASE 10:
Revision-based conflict detection.

PHASE 11:
Temporary change cleanup.

STOP after Phase 11.

Do not implement:
- payments
- subscriptions
- R2
- D1
- OAuth
- QR codes
- CRDTs
- version history
- backup
- dashboards
- sharing
- automatic Markdown merging

until the core synchronization loop is working.

The goal tonight is not a production SaaS.

The goal is to prove:

Desktop Obsidian
    ↕
SyncVault
    ↕
Cloudflare
    ↕
SyncVault
    ↕
Mobile Obsidian

with reliable bidirectional synchronization.

Start with Phase 1 and implement the smallest working vertical slice.
