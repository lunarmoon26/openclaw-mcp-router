import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

/** The OpenClaw extension ID and npm package name. */
export const EXTENSION_ID = "openclaw-mcp-router";

/** Version read from package.json — stays in sync with `npm version` / release workflow. */
export const EXTENSION_VERSION: string = _pkg.version;

export const TOOL_MCP_SEARCH = "mcp_search";
export const TOOL_MCP_CALL = "mcp_call";

export const CMD_SETUP = "setup";
export const CMD_ADD_SERVER = "add";
export const CMD_REMOVE_SERVER = "remove";
export const CMD_LIST_SERVER = "list";
export const CMD_REINDEX = "reindex";
export const CMD_DISABLE_SERVER = "disable";
export const CMD_ENABLE_SERVER = "enable";
export const CMD_CONTROL = "control";