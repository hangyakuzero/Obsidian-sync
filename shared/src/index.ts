/** Files are temporary sync data, not a backup.  Keep individual SQLite rows
 * comfortably below the Durable Object 2MiB limit. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Legacy inline base64 payloads (single-hop uploads) stay small: an 8 MiB
 * base64 blob would not fit a SQLite row, so only chunked content reaches
 * MAX_FILE_BYTES. */
export const MAX_INLINE_BYTES = 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;
export const PROTOCOL_VERSION = 2;
export const CHUNK_CAPABILITY = "chunks-v1";

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_PATH_LENGTH = 1024;

export type Operation = "create" | "update" | "delete" | "rename";

export interface ContentReference {
  /** lower-case SHA-256 of the complete file */
  hash: string;
  byteLength: number;
  chunkCount: number;
}

export interface Change {
  operationId: string;
  revision: number;
  deviceId: string;
  path: string;
  operation: Operation;
  oldPath?: string;
  baseRevision: number;
  timestamp: number;
  /** V2 content transport.  `payload` remains readable during migration. */
  content?: ContentReference;
  /** Earlier locally queued mutations this operation intentionally follows. */
  causalParents?: string[];
  payload?: string;
}

export type ClientMessage =
  | { type: "hello"; accountId: string; vaultId: string; deviceId: string; token: string; lastRevision: number; capabilities?: string[] }
  | { type: "change"; change: Change }
  | { type: "ack"; revision: number }
  | { type: "batch"; items: ClientMessage[] };

export type ServerMessage =
  | { type: "welcome"; serverRevision: number; resyncRequired: boolean }
  | { type: "change"; change: Change }
  | { type: "accepted"; operationId: string; revision: number }
  | { type: "conflict"; operationId: string; path: string; conflictPath?: string; serverRevision: number }
  | { type: "error"; code: string; message: string }
  | { type: "batch"; items: ServerMessage[] };

export function normalizePath(raw: string): string {
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error("invalid path: ..");
    if (part.includes("\\") || part.includes("\0")) throw new Error("invalid path segment");
    parts.push(part);
  }
  const path = parts.join("/");
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) throw new Error("invalid path length");
  return path;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isValidBase64(base64: string): boolean {
  if (
    base64.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) ||
    (base64.includes("=") && base64.length % 4 !== 0)
  ) {
    return false;
  }
  try {
    fromBase64(base64);
    return true;
  } catch {
    return false;
  }
}

export function isValidHash(hash: unknown): hash is string {
  return typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
}

export function isValidContentReference(content: unknown): content is ContentReference {
  if (!content || typeof content !== "object") return false;
  const value = content as Partial<ContentReference>;
  return (
    isValidHash(value.hash) &&
    typeof value.byteLength === "number" &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    value.byteLength <= MAX_FILE_BYTES &&
    typeof value.chunkCount === "number" &&
    Number.isSafeInteger(value.chunkCount) &&
    value.chunkCount === Math.max(1, Math.ceil(value.byteLength / CHUNK_BYTES))
  );
}

/** A deterministic key lets the server avoid creating impossible paths on
 * case-insensitive or Unicode-normalising file systems. */
export function pathCollisionKey(path: string): string {
  return normalizePath(path).normalize("NFC").toLocaleLowerCase("en-US");
}
