import { MAX_FILE_BYTES, normalizePath } from "@syncvault/shared";

/** Logical namespace for mirrored Obsidian appearance/config files. Server-side
 * these are ordinary vault paths (the same change stream applies them); only
 * the local plugin maps them to the vault config directory. */
export const VISUAL_NS = "syncvault-visual";
export const NS_PREFIX = `${VISUAL_NS}/`;

/** `appearance.json` (theme, light/dark, snippets) plus every installed theme
 * folder. Everything else under `.obsidian` (workspace, hotkeys, plugin data)
 * is intentionally not synced. */

export interface VisualFs {
  stat(rel: string): Promise<{ kind: "file" | "folder"; size: number } | null>;
  readBytes(rel: string): Promise<Uint8Array | null>;
  /** Bare entry names directly under `rel` (folders and files, unresolved). */
  list(rel: string): Promise<string[]>;
}

export interface VisualChange {
  logicalPath: string;
  bytes: Uint8Array;
}

export class VisualSync {
  constructor(
    private fs: VisualFs,
    private onChange: (change: VisualChange) => void,
    private onTooLarge: (path: string, size: number) => void,
  ) {}

  /** Map a config-relative path (e.g. `appearance.json`, `themes/X/theme.css`)
   * to its logical sync path, or null when it is out of scope. */
  translate(rel: string): string | null {
    if (rel.trim() === "") return null;
    const clean = normalizePath(rel).replace(/^\/+/, "");
    if (clean === "") return null;
    if (clean === "appearance.json" || clean.startsWith("themes/")) {
      return NS_PREFIX + clean;
    }
    return null;
  }

  /** Inverse of translate(); null when `logical` is not a visual path. */
  static relPath(logical: string): string | null {
    if (!logical.startsWith(NS_PREFIX)) return null;
    return logical.slice(NS_PREFIX.length);
  }

  /** Full scan of the visual scope, emitting a change per file. Runs at
   * startup, on manual refresh and on a low-frequency cadence so edits made
   * while the plugin was off or disabled still converge. */
  async scan(): Promise<void> {
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

  private async walk(rel: string, depth: number): Promise<void> {
    if (depth > 8) return; // guard against pathological nesting
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

  private async emitFile(rel: string): Promise<void> {
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
}
