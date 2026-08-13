import { ApiError, STATUS_FOR_CODE } from "./errors";
import type { Env } from "./env";
import { fromBase64, isValidBase64, CHUNK_CAPABILITY, MAX_FILE_BYTES, normalizePath, toBase64, type Change } from "@syncvault/shared";
import { AccountDO } from "./durable-objects/AccountDO";
import { VaultSyncDO } from "./durable-objects/VaultSyncDO";

export { AccountDO, VaultSyncDO };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      const response = await route(request, env);
      return response.webSocket ? response : withCors(response);
    } catch (e) {
      const err = e as ApiError;
      const code = err.code ?? "INTERNAL";
      const status = STATUS_FOR_CODE[code] ?? 500;
      const message = err.message ?? "internal error";
      if (status >= 500) console.error("unhandled", err);
      return withCors(
        Response.json({ error: code, message }, { status }),
      );
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && parts[0] === "health") {
    return Response.json({ status: "ok", service: "syncvault" });
  }

  if (parts[0] !== "v1") {
    return Response.json({ error: "NOT_FOUND", message: "unknown route" }, { status: 404 });
  }
  const [head, ...rest] = parts.slice(1);

  switch (head) {
    case "accounts": {
      if (request.method !== "POST" || rest.length !== 0) break;
      const body = await request.json<{ accountId?: string; password?: string }>();
      if (!body.accountId || typeof body.password !== "string") {
        throw new ApiError("BAD_REQUEST", "accountId and password required");
      }
      const result = await env.ACCOUNT_DO.getByName(body.accountId).createAccount(body.accountId, body.password);
      if (!result.ok) throw new ApiError(result.code, result.message);
      return Response.json({ accountId: result.value.accountId }, { status: 201 });
    }
    case "login": {
      if (request.method !== "POST" || rest.length !== 0) break;
      const body = await request.json<{ accountId?: string; password?: string }>();
      if (!body.accountId || typeof body.password !== "string") {
        throw new ApiError("BAD_REQUEST", "accountId and password required");
      }
      const result = await env.ACCOUNT_DO.getByName(body.accountId).verifyLogin(body.accountId, body.password);
      if (!result.ok) throw new ApiError(result.code, result.message);
      return Response.json({ ok: true });
    }
    case "vaults": {
      if (request.method === "POST" && rest.length === 0) {
        const body = await request.json<{ accountId?: string; password?: string; name?: string }>();
        if (!body.accountId || typeof body.password !== "string" || typeof body.name !== "string") {
          throw new ApiError("BAD_REQUEST", "accountId, password and name required");
        }
        const login = await env.ACCOUNT_DO.getByName(body.accountId).verifyLogin(body.accountId, body.password);
        if (!login.ok) throw new ApiError(login.code, login.message);
        const vault = await env.ACCOUNT_DO.getByName(body.accountId).createVault(body.accountId, body.name);
        if (!vault.ok) throw new ApiError(vault.code, vault.message);
        return Response.json(vault.value, { status: 201 });
      }
      if (request.method === "GET" && rest.length === 0) {
        const auth = bearer(request);
        if (!auth) throw new ApiError("UNAUTHORIZED", "missing token");
        const result = await env.ACCOUNT_DO.getByName(auth.accountId).listVaults(auth.accountId, auth.deviceId, auth.token);
        if (!result.ok) throw new ApiError(result.code, result.message);
        return Response.json({ vaults: result.value });
      }
      if (request.method === "POST" && rest.length === 1 && rest[0] === "list") {
        const body = await request.json<{ accountId?: string; password?: string }>();
        if (!body.accountId || typeof body.password !== "string") {
          throw new ApiError("BAD_REQUEST", "accountId and password required");
        }
        const result = await env.ACCOUNT_DO
          .getByName(body.accountId)
          .listVaultsByPassword(body.accountId, body.password);
        if (!result.ok) throw new ApiError(result.code, result.message);
        return Response.json({ vaults: result.value });
      }
      if (rest.length === 2 && rest[1] === "sync" && request.method === "GET") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) {
          throw new ApiError("UNAUTHORIZED", "invalid token");
        }
        const sinceRaw = url.searchParams.get("since") ?? "0";
        if (!/^\d+$/.test(sinceRaw)) throw new ApiError("BAD_REQUEST", "invalid cursor");
        const since = Number(sinceRaw);
        const capabilities = (url.searchParams.get("capabilities") ?? "").split(",").filter(Boolean);
        const stub = env.VAULT_DO.getByName(rest[0]);
        return Response.json(await rpc(stub.syncSince(auth.deviceId, since, capabilities)));
      }
      if (rest.length === 2 && rest[1] === "changes" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) {
          throw new ApiError("UNAUTHORIZED", "invalid token");
        }
        const change = await request.json<Change>();
        try {
          normalizePath(change.path);
          if (change.oldPath !== undefined) normalizePath(change.oldPath);
        } catch (error) {
          throw new ApiError("BAD_REQUEST", (error as Error).message);
        }
        // Validate here (not only inside the DO) so the error code survives the
        // DO RPC boundary and maps to a clean 4xx response.
        if (change.content) {
          throw new ApiError("UPLOAD_REQUIRED", "chunked content must use the upload endpoints");
        }
        if (
          (change.operation === "create" || change.operation === "update") &&
          typeof change.payload !== "string"
        ) {
          throw new ApiError("PAYLOAD_REQUIRED", "file content required");
        }
        if (
          (change.operation === "create" || change.operation === "update") &&
          (!isValidBase64(change.payload!) || fromBase64(change.payload!).byteLength > MAX_FILE_BYTES)
        ) {
          throw new ApiError("BAD_REQUEST", "file content is not valid or exceeds the size limit");
        }
        const capabilities = (url.searchParams.get("capabilities") ?? "").split(",").filter(Boolean);
        const result = await rpc(env.VAULT_DO.getByName(rest[0]).submitChange(change, auth.deviceId, {
          strict: capabilities.includes(CHUNK_CAPABILITY),
        }));
        if (result.status === "accepted") {
          return Response.json({ status: "accepted", revision: result.revision });
        }
        return Response.json({
          status: "conflict",
          path: result.path,
          conflictPath: result.conflictPath,
          serverRevision: result.serverRevision,
        });
      }
      if (rest.length === 2 && rest[1] === "uploads" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) throw new ApiError("UNAUTHORIZED", "invalid token");
        const change = await request.json<Change>();
        const result = await rpc(env.VAULT_DO.getByName(rest[0]).beginUpload({ ...change, deviceId: auth.deviceId }, auth.deviceId));
        return Response.json(result, { status: result.acceptedRevision ? 200 : 201 });
      }
      if (rest.length === 5 && rest[1] === "uploads" && rest[3] === "chunks" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) throw new ApiError("UNAUTHORIZED", "invalid token");
        const index = Number(rest[4]);
        const body = await request.json<{ data?: string }>();
        if (typeof body.data !== "string" || !isValidBase64(body.data)) throw new ApiError("BAD_REQUEST", "chunk data must be Base64");
        await rpc(env.VAULT_DO.getByName(rest[0]).uploadChunk(rest[2], auth.deviceId, index, fromBase64(body.data)));
        return Response.json({ ok: true });
      }
      if (rest.length === 4 && rest[1] === "uploads" && rest[3] === "complete" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) throw new ApiError("UNAUTHORIZED", "invalid token");
        return Response.json(await rpc(env.VAULT_DO.getByName(rest[0]).completeUpload(rest[2], auth.deviceId)));
      }
      if (rest.length === 5 && rest[1] === "revisions" && rest[3] === "chunks" && request.method === "GET") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) throw new ApiError("UNAUTHORIZED", "invalid token");
        const bytes = await rpc(env.VAULT_DO.getByName(rest[0]).getChangeChunk(Number(rest[2]), Number(rest[4])));
        return Response.json({ data: toBase64(bytes) });
      }
      if (rest.length === 2 && rest[1] === "ack" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) {
          throw new ApiError("UNAUTHORIZED", "invalid token");
        }
        const body = await request.json<{ revision?: number }>();
        if (typeof body.revision !== "number") {
          throw new ApiError("BAD_REQUEST", "revision required");
        }
        await rpc(env.VAULT_DO.getByName(rest[0]).ack(auth.deviceId, body.revision));
        return Response.json({ ok: true });
      }
      if (rest.length === 2 && rest[1] === "reset" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) {
          throw new ApiError("UNAUTHORIZED", "invalid token");
        }
        const body = await request.json<{ accountId?: string; password?: string; confirm?: string }>();
        if (!body.accountId || typeof body.password !== "string" || typeof body.confirm !== "string") {
          throw new ApiError("BAD_REQUEST", "accountId, password and confirm required");
        }
        if (body.accountId !== auth.accountId) {
          throw new ApiError("UNAUTHORIZED", "invalid token");
        }
        const login = await env.ACCOUNT_DO.getByName(body.accountId).verifyLogin(body.accountId, body.password);
        if (!login.ok) throw new ApiError(login.code, login.message);
        const vault = await env.ACCOUNT_DO.getByName(body.accountId).getVault(body.accountId, rest[0]);
        if (!vault.ok) throw new ApiError(vault.code, vault.message);
        if (body.confirm !== rest[0] && body.confirm !== vault.value.name) {
          throw new ApiError("BAD_REQUEST", "confirmation does not match the vault");
        }
        await env.VAULT_DO.getByName(rest[0]).resetVault();
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && rest.length === 2 && rest[1] === "devices") {
        const vaultId = rest[0];
        const body = await request.json<{ accountId?: string; password?: string; deviceId?: string; name?: string }>();
        if (!body.accountId || typeof body.password !== "string" || typeof body.deviceId !== "string") {
          throw new ApiError("BAD_REQUEST", "accountId, password and deviceId required");
        }
        const result = await env.ACCOUNT_DO
          .getByName(body.accountId)
          .registerDevice(body.accountId, vaultId, body.password, body.deviceId, body.name ?? "");
        if (!result.ok) throw new ApiError(result.code, result.message);
        return Response.json(result.value, { status: 201 });
      }
      if (rest.length === 2 && rest[1] === "ws") {
        return proxySocket(env, rest[0], url, request);
      }
      break;
    }
    default:
      break;
  }
  return Response.json({ error: "NOT_FOUND", message: "unknown route" }, { status: 404 });
}

async function proxySocket(env: Env, vaultId: string, url: URL, request: Request): Promise<Response> {
  const accountId = url.searchParams.get("accountId");
  const deviceId = url.searchParams.get("deviceId");
  if (!accountId || !deviceId) {
    return Response.json({ error: "BAD_REQUEST", message: "accountId and deviceId required" }, { status: 400 });
  }
  const upgrade = request.headers.get("Upgrade");
  if (upgrade !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  return env.VAULT_DO.getByName(vaultId).fetch(request);
}

async function authDevice(env: Env, auth: Auth, vaultId: string): Promise<boolean> {
  return env.ACCOUNT_DO
    .getByName(auth.accountId)
    .verifyDevice(auth.accountId, auth.deviceId, auth.token, vaultId);
}

/** ApiError codes do not survive the Durable Object RPC boundary (only the
 * message does), so re-derive the code from controlled server messages. */
const DO_ERROR_CODES: [prefix: string, code: string][] = [
  ["baseRevision ahead of server", "BAD_REQUEST"],
  ["local history is older than the retention window", "RESYNC_REQUIRED"],
  ["invalid content descriptor", "BAD_REQUEST"],
  ["missing operationId", "BAD_REQUEST"],
  ["invalid baseRevision", "BAD_REQUEST"],
  ["invalid causalParents", "BAD_REQUEST"],
  ["file content required", "PAYLOAD_REQUIRED"],
  ["file content is not valid Base64", "BAD_REQUEST"],
  ["file exceeds inline size limit; use chunked upload", "PAYLOAD_TOO_LARGE"],
  ["unknown operation:", "BAD_REQUEST"],
  ["invalid path:", "BAD_REQUEST"],
  ["invalid path segment", "BAD_REQUEST"],
  ["invalid path length", "BAD_REQUEST"],
  ["vault storage is full", "INSUFFICIENT_STORAGE"],
  ["upload session not found", "NOT_FOUND"],
  ["invalid upload chunk", "BAD_REQUEST"],
  ["invalid chunk size or index", "BAD_REQUEST"],
  ["invalid final chunk size", "BAD_REQUEST"],
  ["not all file chunks have arrived", "UPLOAD_INCOMPLETE"],
  ["uploaded bytes do not match declared SHA-256", "HASH_MISMATCH"],
  ["uploaded file has the wrong length", "UPLOAD_INCOMPLETE"],
  ["invalid acknowledgement revision", "BAD_REQUEST"],
  ["this vault contains chunked content; update SyncVault", "CLIENT_UPGRADE_REQUIRED"],
  ["could not allocate conflict path", "CONFLICT"],
];

async function rpc<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (e) {
    const raw = e instanceof Error ? (e as Error).message : "";
    const message = raw.replace(/^ApiError: /, "");
    const entry = DO_ERROR_CODES.find(([prefix]) => message.startsWith(prefix));
    const code = entry?.[1] ?? "INTERNAL";
    if (code === "INTERNAL") console.error("unhandled DO error", e);
    throw new ApiError(code, message);
  }
}

interface Auth {
  accountId: string;
  deviceId: string;
  token: string;
}

function bearer(request: Request): Auth | null {
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const [accountId, deviceId, token] = header.slice(7).split(":");
  if (!accountId || !deviceId || !token) return null;
  return { accountId, deviceId, token };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
