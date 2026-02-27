import { createServer } from "node:http";
import open from 'open';
import fs from "node:fs";
import path from "node:path";
import { cancel, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CMD_REINDEX, EXTENSION_ID, EXTENSION_VERSION } from "../constants.js";
import type { ServerIndexResult } from "../indexer.js";
import {
  getPluginConfig,
  locateOpenclawConfig,
  patchMcpJsonServer,
  patchPluginConfig,
  readOpenclawConfig,
  resolveRawMcpServers,
  resolveServerSource,
  writeOpenclawConfig,
} from "./config-writer.js";

type RawServer = Record<string, unknown>;
type StatusFile = { timestamp: string; servers: ServerIndexResult[] };

function abortIfCancel(value: unknown): void {
  if (isCancel(value)) {
    cancel("Control cancelled.");
    process.exit(0);
  }
}

function readStatusFile(configPath: string): StatusFile | null {
  const statusPath = path.join(path.dirname(configPath), EXTENSION_ID, "status.json");
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8")) as StatusFile;
  } catch {
    return null;
  }
}

/** Remove any recorded error for a server so it shows "not indexed" instead of "failed". */
function clearServerError(configPath: string, serverName: string): void {
  const statusPath = path.join(path.dirname(configPath), EXTENSION_ID, "status.json");
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as StatusFile;
    status.servers = status.servers.filter((s) => s.name !== serverName);
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n", "utf-8");
  } catch { /* no status file yet — nothing to clear */ }
}

function serverStatusLabel(name: string, srv: RawServer, statusMap: Map<string, ServerIndexResult>): string {
  const transport =
    typeof srv.type === "string" ? srv.type :
    typeof srv.command === "string" ? "stdio" : "http";

  if (srv.disabled === true) return `${name}  (${transport})  ● disabled`;

  const s = statusMap.get(name);
  if (!s) return `${name}  (${transport})  ○ not indexed`;
  if (s.error) {
    const brief = s.error.replace(/^Error:\s*/i, "").slice(0, 50);
    return `${name}  (${transport})  ✕ failed: ${brief}`;
  }
  if (s.failed > 0) return `${name}  (${transport})  ◑ partial — ${s.indexed} tools (${s.failed} errors)`;
  return `${name}  (${transport})  ✓ ok — ${s.indexed} tools`;
}

function isHttpTransport(srv: RawServer): boolean {
  const t = typeof srv.type === "string" ? srv.type : typeof srv.command === "string" ? "stdio" : "http";
  return t === "http" || t === "sse";
}

// ── Header editing ────────────────────────────────────────────────────────────

async function showSetHeader(srv: RawServer): Promise<RawServer | null> {
  const headers = (srv.headers ?? {}) as Record<string, string>;
  const existing = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("  |  ");
  if (existing) log.info(`Current headers: ${existing}`);

  const name = await text({
    message: "Header name",
    placeholder: "Authorization",
  });
  abortIfCancel(name);
  if (!(name as string).trim()) return null;

  const value = await text({
    message: "Header value",
    placeholder: "Bearer your-token-here",
  });
  abortIfCancel(value);

  return { ...srv, headers: { ...headers, [(name as string).trim()]: (value as string).trim() } };
}

async function showRemoveHeader(srv: RawServer): Promise<RawServer | null> {
  const headers = (srv.headers ?? {}) as Record<string, string>;
  const keys = Object.keys(headers);
  if (keys.length === 0) { log.warn("No headers set."); return null; }

  const choice = await select<string>({
    message: "Remove which header?",
    options: [
      ...keys.map((k) => ({ value: k, label: `${k}: ${headers[k]}` })),
      { value: "__cancel__", label: "Cancel" },
    ],
  });
  abortIfCancel(choice);
  if ((choice as string) === "__cancel__") return null;

  const { [(choice as string)]: _removed, ...rest } = headers;
  const updated = { ...srv, headers: rest };
  if (Object.keys(rest).length === 0) delete (updated as Record<string, unknown>).headers;
  return updated;
}

// ── Env var editing ───────────────────────────────────────────────────────────

async function showSetEnvVar(srv: RawServer): Promise<RawServer | null> {
  const env = (srv.env ?? {}) as Record<string, string>;
  const existing = Object.entries(env).map(([k]) => k).join(", ");
  if (existing) log.info(`Current env vars: ${existing}`);

  const key = await text({
    message: "Environment variable name",
    placeholder: "API_TOKEN",
  });
  abortIfCancel(key);
  if (!(key as string).trim()) return null;

  const value = await text({
    message: "Value",
    placeholder: "your-secret-token",
  });
  abortIfCancel(value);

  return { ...srv, env: { ...env, [(key as string).trim()]: (value as string).trim() } };
}

async function showRemoveEnvVar(srv: RawServer): Promise<RawServer | null> {
  const env = (srv.env ?? {}) as Record<string, string>;
  const keys = Object.keys(env);
  if (keys.length === 0) { log.warn("No env vars set."); return null; }

  const choice = await select<string>({
    message: "Remove which env var?",
    options: [
      ...keys.map((k) => ({ value: k, label: k })),
      { value: "__cancel__", label: "Cancel" },
    ],
  });
  abortIfCancel(choice);
  if ((choice as string) === "__cancel__") return null;

  const { [(choice as string)]: _removed, ...rest } = env;
  const updated = { ...srv, env: rest };
  if (Object.keys(rest).length === 0) delete (updated as Record<string, unknown>).env;
  return updated;
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

const OAUTH_CALLBACK_PORT = 8090;
const OAUTH_CALLBACK_URL = `http://localhost:${OAUTH_CALLBACK_PORT}/callback`;

async function openBrowser(url: string): Promise<void> {
  await open(url); // handles darwin/win32/linux internally
}

async function showOAuthFlow(srv: RawServer): Promise<RawServer | null> {
  const serverUrl =
    typeof srv.url === "string" ? srv.url :
    typeof srv.serverUrl === "string" ? srv.serverUrl : null;
  if (!serverUrl) { log.warn("Server has no URL configured."); return null; }

  // In-memory state for the OAuth provider
  let storedTokens: OAuthTokens | undefined;
  let storedClientInfo: OAuthClientInformationMixed | undefined;
  let storedCodeVerifier = "";

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  // Start the local callback server before attempting connection
  const callbackServer = createServer((req, res) => {
    if (req.url === "/favicon.ico") { res.writeHead(404); res.end(); return; }
    const parsed = new URL(req.url ?? "", `http://localhost:${OAUTH_CALLBACK_PORT}`);
    const code = parsed.searchParams.get("code");
    const error = parsed.searchParams.get("error");
    if (code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>");
      resolveCode(code);
    } else {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<html><body><h1>Authorization failed</h1><p>${error ?? "Unknown error"}</p></body></html>`);
      rejectCode(new Error(`OAuth authorization failed: ${error ?? "unknown"}`));
    }
    setTimeout(() => callbackServer.close(), 3000);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      callbackServer.once("error", (err: NodeJS.ErrnoException) => {
        reject(
          err.code === "EADDRINUSE"
            ? new Error(`Port ${OAUTH_CALLBACK_PORT} is already in use. Please free it and try again.`)
            : err,
        );
      });
      callbackServer.listen(OAUTH_CALLBACK_PORT, () => resolve());
    });
  } catch (err) {
    log.error(`Could not start OAuth callback server: ${String(err)}`);
    return null;
  }

  const provider: OAuthClientProvider = {
    get redirectUrl() { return OAUTH_CALLBACK_URL; },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "OpenClaw MCP Router",
        redirect_uris: [OAUTH_CALLBACK_URL],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => storedClientInfo,
    saveClientInformation: (info) => { storedClientInfo = info; },
    tokens: () => storedTokens,
    saveTokens: (tokens) => { storedTokens = tokens; },
    redirectToAuthorization: (authUrl) => {
      log.info(`Opening browser: ${authUrl.toString()}`);
      openBrowser(authUrl.toString());
    },
    saveCodeVerifier: (verifier) => { storedCodeVerifier = verifier; },
    codeVerifier: () => storedCodeVerifier,
  };

  const transport =
    isHttpTransport(srv) && (srv.type as string) !== "sse"
      ? new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider })
      : new SSEClientTransport(new URL(serverUrl), { authProvider: provider });

  const client = new Client({ name: EXTENSION_ID, version: EXTENSION_VERSION }, { capabilities: {} });

  const s = spinner();
  try {
    s.start("Connecting to server...");
    try {
      await client.connect(transport);
      s.stop("Server is already authenticated — no OAuth needed.");
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
      s.stop("OAuth required — waiting for browser authorization...");
      log.info(`If the browser did not open automatically, visit:\n  ${OAUTH_CALLBACK_URL.replace("/callback", "")}`);

      const code = await codePromise;
      s.start("Exchanging authorization code...");
      await transport.finishAuth(code);
      s.stop("Token received. Reconnecting...");
      // The original transport is already started — create a fresh one with the
      // same provider (which now holds the saved tokens) before reconnecting.
      const transport2 =
        isHttpTransport(srv) && (srv.type as string) !== "sse"
          ? new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider })
          : new SSEClientTransport(new URL(serverUrl), { authProvider: provider });
      s.start("Reconnecting with token...");
      await client.connect(transport2);
      s.stop("Connected.");
    }

    const tokens = await provider.tokens();
    if (!tokens?.access_token) {
      log.warn("OAuth completed but no access token was obtained.");
      return null;
    }

    log.success("OAuth authentication successful — Bearer token saved.");
    const headers = (srv.headers ?? {}) as Record<string, string>;
    return { ...srv, headers: { ...headers, Authorization: `Bearer ${tokens.access_token}` } };
  } catch (err) {
    s.stop("OAuth flow failed.");
    log.error(`OAuth error: ${String(err)}`);
    return null;
  } finally {
    callbackServer.close();
    await client.close().catch(() => {});
  }
}

// ── Reconnect test ────────────────────────────────────────────────────────────

async function showReconnect(serverName: string, srv: RawServer): Promise<null> {
  const s = spinner();
  s.start(`Connecting to "${serverName}"...`);

  let transport;
  try {
    const transportType =
      typeof srv.type === "string" ? srv.type :
      typeof srv.command === "string" ? "stdio" : "http";

    if (transportType === "stdio") {
      if (typeof srv.command !== "string") {
        s.stop("No command configured for stdio server.");
        return null;
      }
      transport = new StdioClientTransport({
        command: srv.command,
        args: Array.isArray(srv.args) ? (srv.args as string[]) : [],
        env: { ...process.env, ...((srv.env ?? {}) as Record<string, string>) } as Record<string, string>,
      });
    } else if (transportType === "sse") {
      const url = typeof srv.url === "string" ? srv.url : typeof srv.serverUrl === "string" ? srv.serverUrl : null;
      if (!url) { s.stop("No URL configured."); return null; }
      transport = new SSEClientTransport(new URL(url), {
        requestInit: srv.headers ? { headers: srv.headers as Record<string, string> } : undefined,
      });
    } else {
      const url = typeof srv.url === "string" ? srv.url : typeof srv.serverUrl === "string" ? srv.serverUrl : null;
      if (!url) { s.stop("No URL configured."); return null; }
      transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: srv.headers ? { headers: srv.headers as Record<string, string> } : undefined,
      });
    }

    const client = new Client({ name: EXTENSION_ID, version: EXTENSION_VERSION }, { capabilities: {} });
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close().catch(() => {});
    s.stop(`Connected — ${tools.length} tool${tools.length === 1 ? "" : "s"} available.`);
  } catch (err) {
    s.stop(`Connection failed: ${String(err)}`);
  }

  return null;
}

// ── Per-server action menu ────────────────────────────────────────────────────

async function configureServer(serverName: string, srv: RawServer): Promise<RawServer | null> {
  const isDisabled = srv.disabled === true;
  const httpServer = isHttpTransport(srv);

  const hasHeaders = Object.keys((srv.headers ?? {}) as object).length > 0;
  const hasEnv = Object.keys((srv.env ?? {}) as object).length > 0;

  const action = await select<string>({
    message: `Configure "${serverName}"`,
    options: [
      {
        value: "toggle",
        label: isDisabled ? "Enable server" : "Disable server",
        hint: isDisabled ? "Resume indexing this server" : "Skip this server during indexing",
      },
      ...(httpServer
        ? [
            { value: "oauth_auth", label: "Authenticate with OAuth", hint: "Open browser to complete OAuth and save Bearer token" },
            { value: "set_header", label: "Set auth header", hint: "Add or update a request header (e.g. Authorization: Bearer …)" },
            ...(hasHeaders ? [{ value: "remove_header", label: "Remove a header" }] : []),
          ]
        : [
            { value: "set_env", label: "Set environment variable", hint: "Add or update an env var passed to the server process" },
            ...(hasEnv ? [{ value: "remove_env", label: "Remove an env var" }] : []),
          ]),
      { value: "reconnect", label: "Test connection", hint: "Connect and report how many tools are available" },
      { value: "back", label: "← Back to server list" },
    ],
  });
  abortIfCancel(action);

  switch (action as string) {
    case "toggle": {
      if (isDisabled) {
        const { disabled: _d, ...rest } = srv as Record<string, unknown>;
        return rest;
      }
      return { ...srv, disabled: true };
    }
    case "reconnect":    return showReconnect(serverName, srv);
    case "oauth_auth":   return showOAuthFlow(srv);
    case "set_header":   return showSetHeader(srv);
    case "remove_header": return showRemoveHeader(srv);
    case "set_env":      return showSetEnvVar(srv);
    case "remove_env":   return showRemoveEnvVar(srv);
    default:             return null; // "back"
  }
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runControlCommand(): Promise<void> {
  const configPath = locateOpenclawConfig();
  intro(`${EXTENSION_ID} control`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const mcpServers = resolveRawMcpServers(configPath) as Record<string, RawServer>;
    const serverNames = Object.keys(mcpServers);

    if (serverNames.length === 0) {
      log.warn(`No servers configured. Run: openclaw ${EXTENSION_ID} setup`);
      break;
    }

    const statusFile = readStatusFile(configPath);
    const statusMap = new Map((statusFile?.servers ?? []).map((s) => [s.name, s]));

    const serverChoice = await select<string>({
      message: "Select a server",
      options: [
        ...serverNames.map((name) => ({
          value: name,
          label: serverStatusLabel(name, mcpServers[name] ?? {}, statusMap),
        })),
        { value: "__done__", label: "Done" },
      ],
    });
    abortIfCancel(serverChoice);
    if ((serverChoice as string) === "__done__") break;

    const serverName = serverChoice as string;
    const currentSrv = { ...(mcpServers[serverName] ?? {}) as RawServer };
    const wasDisabled = currentSrv.disabled === true;

    const updatedSrv = await configureServer(serverName, currentSrv);
    if (updatedSrv === null) continue; // "back" or no-op

    // Persist the change — route to the file the server originally came from
    const hadError = statusMap.get(serverName)?.error != null;
    const source = resolveServerSource(configPath, serverName);
    if (source === "file") {
      patchMcpJsonServer(configPath, serverName, () => updatedSrv);
    } else {
      const freshConfig = readOpenclawConfig(configPath);
      const freshPluginCfg = getPluginConfig(freshConfig);
      const newServers = { ...(freshPluginCfg.mcpServers ?? {}) as Record<string, unknown>, [serverName]: updatedSrv };
      writeOpenclawConfig(configPath, patchPluginConfig(freshConfig, { ...freshPluginCfg, mcpServers: newServers }));
    }

    // If the server had a recorded error, clear it so the status shows
    // "not indexed" rather than "failed" until the next reindex run.
    if (hadError) clearServerError(configPath, serverName);

    const nowDisabled = updatedSrv.disabled === true;

    if (!wasDisabled && nowDisabled) {
      log.success(`"${serverName}" disabled.`);
    } else if (wasDisabled && !nowDisabled) {
      log.success(`"${serverName}" enabled. Run: openclaw ${EXTENSION_ID} ${CMD_REINDEX} --server ${serverName}`);
    } else {
      log.success(`"${serverName}" updated. Run: openclaw ${EXTENSION_ID} ${CMD_REINDEX} --server ${serverName}`);
    }
  }

  outro("Done");
}
