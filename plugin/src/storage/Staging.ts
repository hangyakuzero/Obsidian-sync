import { ensureParentFolders } from "../vault/ensureParentFolders";

export interface StagedFileAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  remove(path: string): Promise<void>;
  /** File names inside `folder` (not full paths). */
  list(folder: string): Promise<string[]>;
}

/**
 * Durable staged file content under the plugin's own excluded data directory.
 * The queue persists only metadata plus a staged-file reference; bytes are
 * snapshotted here at capture time so a concurrently edited vault file cannot
 * corrupt an upload, and plugin settings JSON never carries base64 blobs.
 */
export interface Staging {
  save(operationId: string, bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  load(operationId: string): Promise<Uint8Array<ArrayBuffer> | null>;
  remove(operationId: string): Promise<void>;
  list(): Promise<string[]>;
}

export class VaultStaging implements Staging {
  readonly dir: string;

  constructor(
    private adapter: StagedFileAdapter,
    dir: string,
  ) {
    this.dir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  }

  private path(operationId: string): string {
    return `${this.dir}/${operationId}`;
  }

  async save(operationId: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    await ensureParentFolders(this.adapter, this.path(operationId));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await this.adapter.writeBinary(this.path(operationId), buffer);
  }

  async load(operationId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const p = this.path(operationId);
    if (!(await this.adapter.exists(p))) return null;
    try {
      const data = await this.adapter.readBinary(p);
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch {
      return null;
    }
  }

  async remove(operationId: string): Promise<void> {
    const p = this.path(operationId);
    if (await this.adapter.exists(p)) {
      await this.adapter.remove(p);
    }
  }

  async list(): Promise<string[]> {
    try {
      return await this.adapter.list(this.dir);
    } catch {
      return [];
    }
  }
}

/** In-memory staging used by the test harness. */
export class MemoryStaging implements Staging {
  private files = new Map<string, Uint8Array<ArrayBuffer>>();

  async save(operationId: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    this.files.set(operationId, new Uint8Array(bytes));
  }

  async load(operationId: string): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.files.get(operationId) ?? null;
  }

  async remove(operationId: string): Promise<void> {
    this.files.delete(operationId);
  }

  async list(): Promise<string[]> {
    return [...this.files.keys()];
  }
}
