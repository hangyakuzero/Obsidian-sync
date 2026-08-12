import { ApiError, STATUS_FOR_CODE } from "./errors";
import type { Env } from "./env";
import { fromBase64, isValidBase64, MAX_FILE_BYTES, normalizePath, type Change } from "@syncvault/shared";
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
        const since = Math.max(0, parseInt(url.searchParams.get("since") ?? "0", 10) || 0);
        const stub = env.VAULT_DO.getByName(rest[0]);
        const [statusRes, changes] = await Promise.all([
          stub.status(),
          stub.changesAfter(since),
        ]);
        return Response.json({
          currentRevision: statusRes.currentRevision,
          minRetainedRevision: statusRes.minRetainedRevision,
          resyncRequired:
            since > statusRes.currentRevision || since < statusRes.minRetainedRevision - 1,
          changes,
        });
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
        const result = await env.VAULT_DO.getByName(rest[0]).submitChange(change, auth.deviceId);
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
      if (rest.length === 2 && rest[1] === "ack" && request.method === "POST") {
        const auth = bearer(request);
        if (!auth || !(await authDevice(env, auth, rest[0]))) {
          throw new ApiError("UNAUTHORIZED", "invalid token");
        }
        const body = await request.json<{ revision?: number }>();
        if (typeof body.revision !== "number") {
          throw new ApiError("BAD_REQUEST", "revision required");
        }
        await env.VAULT_DO.getByName(rest[0]).ack(auth.deviceId, body.revision);
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
