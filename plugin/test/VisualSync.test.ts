import { describe, expect, it } from "vitest";
import { VisualSync, VisualChange, NS_PREFIX } from "../src/visual/VisualSync";

class MemoryVisualFs {
  files = new Map<string, Uint8Array>();

  async stat(rel: string) {
    const direct = this.files.get(rel);
    if (direct !== undefined) return { kind: "file" as const, size: direct.byteLength };
    const children = [...this.files.keys()].filter((p) => p.startsWith(rel.endsWith("/") ? rel : `${rel}/`));
    return children.length > 0 ? { kind: "folder" as const, size: 0 } : null;
  }

  async readBytes(rel: string) {
    return this.files.get(rel) ?? null;
  }

  async list(rel: string) {
    const prefix = rel.endsWith("/") ? rel : `${rel}/`;
    const names = new Set<string>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash >= 0 ? rest.slice(0, slash) : rest);
    }
    return [...names];
  }
}

function setup() {
  const fs = new MemoryVisualFs();
  const changes: VisualChange[] = [];
  const tooLarge: { path: string; size: number }[] = [];
  const visual = new VisualSync(
    {
      stat: (rel) => fs.stat(rel),
      readBytes: (rel) => fs.readBytes(rel),
      list: (rel) => fs.list(rel),
    },
    (change) => changes.push(change),
    (path, size) => tooLarge.push({ path, size }),
  );
  return { fs, changes, tooLarge, visual };
}

describe("VisualSync", () => {
  it("translates only appearance.json and themes into the logical namespace", () => {
    const { visual } = setup();
    expect(visual.translate("appearance.json")).toBe(`${NS_PREFIX}appearance.json`);
    expect(visual.translate("themes/Atom/theme.css")).toBe(`${NS_PREFIX}themes/Atom/theme.css`);
    expect(visual.translate("themes/Atom/assets/bg.png")).toBe(`${NS_PREFIX}themes/Atom/assets/bg.png`);
    expect(visual.translate("workspace.json")).toBeNull();
    expect(visual.translate("hotkeys.json")).toBeNull();
    expect(visual.translate("")).toBeNull();
    expect(visual.translate("/appearance.json")).toBe(`${NS_PREFIX}appearance.json`);
  });

  it("maps logical paths back to config-relative paths", () => {
    expect(VisualSync.relPath(`${NS_PREFIX}appearance.json`)).toBe("appearance.json");
    expect(VisualSync.relPath(`${NS_PREFIX}themes/Atom/theme.css`)).toBe("themes/Atom/theme.css");
    expect(VisualSync.relPath(`some/other/file.md`)).toBeNull();
  });

  it("scans appearance.json and installed themes into changes", async () => {
    const { fs, changes, visual } = setup();
    fs.files.set(
      "appearance.json",
      new TextEncoder().encode('{"cssTheme":"Atom","theme":"obsidian"}'),
    );
    fs.files.set("themes/Atom/theme.css", new TextEncoder().encode("body { --x: 1 }"));
    fs.files.set("themes/Atom/assets/bg.png", new Uint8Array([1, 2, 3]));
    fs.files.set("themes/Minimal/manifest.json", new TextEncoder().encode("{}"));
    // out of scope: not emitted
    fs.files.set("workspace.json", new TextEncoder().encode("{ }"));
    await visual.scan();
    const paths = changes.map((c) => c.logicalPath).sort();
    expect(paths).toEqual([
      `${NS_PREFIX}appearance.json`,
      `${NS_PREFIX}themes/Atom/assets/bg.png`,
      `${NS_PREFIX}themes/Atom/theme.css`,
      `${NS_PREFIX}themes/Minimal/manifest.json`,
    ]);
    const css = changes.find((c) => c.logicalPath.endsWith("theme.css"))!;
    expect(new TextDecoder().decode(css.bytes)).toBe("body { --x: 1 }");
  });

  it("skips missing appearance (nothing configured) and oversized files", async () => {
    const { fs, changes, tooLarge, visual } = setup();
    fs.files.set("themes/Big/theme.css", new Uint8Array(20 * 1024 * 1024));
    await visual.scan();
    expect(changes).toEqual([]);
    expect(tooLarge).toEqual([{ path: `${NS_PREFIX}themes/Big/theme.css`, size: 20 * 1024 * 1024 }]);
  });
});