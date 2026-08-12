export interface FolderAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
}

/** Create every parent directory needed by a vault-relative file path. */
export async function ensureParentFolders(adapter: FolderAdapter, filePath: string): Promise<void> {
  const parts = filePath.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      // Another event may have created the folder between exists() and mkdir().
      if (!(await adapter.exists(current))) throw error;
    }
  }
}
