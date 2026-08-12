export const MAX_FILE_BYTES = 1_048_576;

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const MAX_PATH_LENGTH = 1024;

export type Operation = "create" | "update" | "delete" | "rename";

export interface Change {
  operationId: string;
  revision: number;
  deviceId: string;
  path: string;
  operation: Operation;
  oldPath?: string;
  baseRevision: number;
  timestamp: number;
  payload?: string;
}

export type ClientMessage =
  | { type: "hello"; accountId: string; vaultId: string; deviceId: string; token: string; lastRevision: number }
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
