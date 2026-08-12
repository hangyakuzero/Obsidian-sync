import { describe, expect, it } from "vitest";
import { ensureParentFolders } from "../src/vault/ensureParentFolders";

describe("ensureParentFolders", () => {
  it("creates all missing parent folders", async () => {
    const folders = new Set<string>();
    const created: string[] = [];
    const adapter = {
      exists: async (path: string) => folders.has(path),
      mkdir: async (path: string) => {
        folders.add(path);
        created.push(path);
      },
    };

    await ensureParentFolders(adapter, "one/two/note.md");
    expect(created).toEqual(["one", "one/two"]);
  });

  it("does nothing for root files and existing folders", async () => {
    const folders = new Set(["one", "one/two"]);
    const created: string[] = [];
    const adapter = {
      exists: async (path: string) => folders.has(path),
      mkdir: async (path: string) => created.push(path),
    };

    await ensureParentFolders(adapter, "note.md");
    await ensureParentFolders(adapter, "one/two/note.md");
    expect(created).toEqual([]);
  });
});
