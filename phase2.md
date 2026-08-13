# SyncVault Phase 2

## Goal

Add safe, opt-in synchronization for Obsidian themes and CSS snippets while
keeping device-specific Obsidian configuration excluded.

Templates stored as ordinary vault files already sync. For example:

```text
Templates/meeting.md
```

The configured template-folder path is not synced because it lives in
Obsidian configuration. Devices should use the same template folder path.

## Current Behavior

The plugin intentionally excludes all `.obsidian` paths. This currently means:

- Normal vault files, including `Templates/*.md`, sync.
- Theme files do not sync.
- CSS snippets do not sync.
- Selected-theme settings do not sync.
- Workspace, plugin, and device configuration do not sync.

## Scope

### Include

When enabled, allow these paths:

```text
.obsidian/themes/**
.obsidian/snippets/**
```

Add a separate optional setting for:

```text
.obsidian/appearance.json
```

`appearance.json` makes the selected theme and appearance settings match, but
it must remain opt-in because it is configuration rather than theme content.

### Continue Excluding

Never sync these paths in Phase 2:

```text
.obsidian/workspace
.obsidian/workspace-mobile.json
.obsidian/plugins/**
.obsidian/hotkeys.json
.obsidian/core-plugins.json
.obsidian/community-plugins.json
.obsidian/cache
.trash/**
```

Do not sync arbitrary `.obsidian` files through a broad prefix exception.
Use one shared allowlist for watching, initial seeding, and validation.

## Settings

Add persistent settings with safe defaults:

```text
Sync theme files: off
Sync CSS snippets: off
Sync selected appearance: off
```

Recommended UI text:

```text
Sync theme files
Sync CSS snippets
Sync selected appearance
```

The settings should explain that appearance synchronization can overwrite the
selected theme and related appearance preferences on another device.

Changing a setting must not automatically delete local files or reset the
vault. Enabling a setting makes matching files eligible on the next scan.

## Implementation Phases

### 1. Shared Path Policy

Create one path-policy helper used by all plugin code:

- `isSyncablePath(path, settings)`
- `isThemePath(path)`
- `isSnippetPath(path)`
- `isAppearancePath(path)`

The helper must normalize paths before checking them and reject traversal,
absolute paths, null bytes, and invalid path lengths.

Update:

- `VaultWatcher.ts`
- `SyncEngine.ts`
- initial seed scanning
- persisted queue validation

Normal vault files must remain syncable regardless of the new settings.

### 2. Settings Persistence

Extend `SyncVaultData` with the three boolean settings. Existing saved data
must migrate safely with all options set to `false` when absent.

Validate the values when loading persisted plugin data. Invalid values should
fall back to `false` rather than enabling configuration synchronization.

### 3. Watcher and Seed Behavior

When each option is enabled:

- Capture local creates, edits, deletes, and renames for matching paths.
- Include matching files during first-run seeding.
- Preserve the existing 1 MiB per-file limit.
- Create parent folders before applying remote theme/snippet files.
- Continue suppressing watcher events caused by remote application.

When an option is disabled:

- Ignore matching local events.
- Do not seed matching files.
- Do not apply matching remote changes; instead, the device should not request
  those changes as part of the selected synchronization policy.

The implementation must define behavior for a device joining a vault where
another device has already synced theme files. The recommended behavior is to
apply only files allowed by the receiving device's settings and advance the
cursor for ignored policy-excluded changes without writing them locally.

This requires an explicit protocol decision before implementation: either
server-side per-device filtering or a client-side ignored-change ACK path.
The preferred option is client-side filtering with a safe, persisted cursor
advance because the server should retain one canonical vault history.

### 4. Appearance Configuration

Treat `.obsidian/appearance.json` separately from theme and snippet files.

If selected appearance synchronization is enabled:

- Sync only the validated appearance file.
- Apply it after theme files have been created.
- Use parent-folder creation before writing it.
- Suppress the resulting Obsidian events.
- Pause with one actionable notice if Obsidian rejects the configuration.

If it is disabled, do not overwrite local appearance settings even when the
server contains another device's appearance change.

Do not include plugin settings, workspace state, or device-specific mobile
layout in this feature.

### 5. Last-write-wins and File Safety

Theme and snippet files use the same server-revision last-write-wins policy as
normal vault files:

- Stale writes are accepted and committed as the latest server revision.
- Remote writes replace local bytes at the target path.
- A remote rename into an occupied destination removes the destination before
  applying the rename.
- Existing files whose names contain `conflict-` remain ordinary files and are
  not cleaned up by synchronization.

Theme and snippet files are plain text, but they still use the normal Base64,
path, payload-size, and queue validation rules.

### 6. Tests

Add unit tests for:

- Theme paths excluded by default.
- Theme paths included when enabled.
- Snippet paths included when enabled.
- Appearance path controlled independently.
- Workspace and plugin paths always excluded.
- Template files in a normal `Templates/` folder syncing normally.
- Nested theme/snippet parent-folder creation.
- Theme/snippet create, update, delete, and rename.
- Disabled-device policy handling and cursor advancement.
- Persisted settings migration and invalid-setting fallback.
- Appearance application ordering after theme files.
- Existing-destination rename replacement behavior.

Add Android manual acceptance tests:

1. Enable theme synchronization on desktop and Android.
2. Install or change a theme on desktop.
3. Confirm the theme file appears on Android.
4. Enable selected appearance synchronization.
5. Confirm the selected theme changes on Android after the next sync.
6. Disable appearance synchronization and confirm local appearance settings
   are not overwritten.
7. Create and edit `Templates/test.md` and confirm it syncs normally.

### 7. Release

Because this is an opt-in plugin feature and does not require a protocol or
worker change, release it as the next plugin feature version after the Phase 1
maintenance release.

Release checklist:

- Run all plugin and worker tests.
- Build with the production worker URL.
- Verify the release bundle contains the expected manifest and assets.
- Confirm defaults leave `.obsidian` synchronization disabled.
- Publish the plugin release.
- Install on desktop first, then Android.
- Do not reset the server vault for this feature unless existing history is
  corrupted; normal theme/template enablement should be incremental.

## Out Of Scope

- Syncing all `.obsidian` configuration.
- Syncing community plugins or plugin data.
- Syncing workspaces or mobile layout state.
- Syncing the configured template-folder preference.
- Theme installation from external URLs.
- Automatic theme downloads.
- Changes to the worker protocol unless per-device filtering requires them.
