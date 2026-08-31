#!/usr/bin/env node
/**
 * @verifasolutionsinc/mcp-server — local stdio MCP server for Verifa.
 *
 * It does not reimplement any tools. It opens one authenticated connection to
 * the hosted Verifa MCP endpoint (streamable HTTP, Bearer = your API key) and
 * forwards tools/list, tools/call, prompts/list and prompts/get verbatim.
 * That keeps the tool surface, PII scrubbing, audit trail and rate limits in
 * one place — the hosted server — and makes this package a few hundred lines
 * that never drift from it.
 *
 * Usage (Claude Desktop / Cursor / any stdio MCP client):
 *   { "mcpServers": { "verifa": {
 *       "command": "npx", "args": ["-y", "@verifasolutionsinc/mcp-server"],
 *       "env": { "VERIFA_API_KEY": "vk_sandbox_...", "VERIFA_ENV": "sandbox" } } } }
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";

import { loadSettings, type Settings } from "./config.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// stdout is the MCP transport — every log line goes to stderr.
const log = (...a: unknown[]) => console.error("[verifa-mcp]", ...a);

async function connectUpstream(s: Settings): Promise<Client> {
  const client = new Client({ name: "verifa-mcp-server", version }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(s.mcpUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${s.apiKey}`,
        "User-Agent": `verifa-mcp-server/${version} node/${process.versions.node}`,
      },
    },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/401|403/.test(msg)) {
      throw new Error(`Verifa rejected the API key (${msg}). Check VERIFA_API_KEY and that its IP allowlist includes this machine.`);
    }
    throw new Error(`Could not reach ${s.mcpUrl}: ${msg}`);
  }
  return client;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(version);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`@verifasolutionsinc/mcp-server ${version}

Local stdio MCP server for Verifa identity verification.

Env:
  VERIFA_API_KEY               required  vk_sandbox_… or vk_live_…
  VERIFA_ENV                   sandbox | live (inferred from the key if omitted)
  VERIFA_API_URL               default https://api.withverifa.com
  VERIFA_MCP_TOOLSETS          comma list, e.g. sessions,checks,identities
  VERIFA_MCP_READ_ONLY=1       hide every tool that writes
  VERIFA_MCP_ALLOW_DESTRUCTIVE=1  expose redaction tools (off by default)

Flags:
  --check     connect, list tools, print a summary, exit
  --version   print version
`);
    return;
  }

  const settings = loadSettings();
  const upstream = await connectUpstream(settings);
  const serverInfo = upstream.getServerVersion();
  log(`connected to ${settings.apiUrl} (${settings.env}) as ${serverInfo?.name ?? "verifa"} ${serverInfo?.version ?? ""}`.trim());

  if (argv.includes("--check")) {
    const { tools } = await upstream.listTools();
    console.log(`OK — ${tools.length} tools available in ${settings.env}${settings.readOnly ? " (read-only)" : ""}:`);
    for (const t of tools) console.log(`  ${t.name}`);
    await upstream.close();
    return;
  }

  const instructions = upstream.getInstructions();
  const server = new Server(
    { name: "verifa", version },
    { capabilities: { tools: {}, prompts: {} }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    upstream.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }),
  );
  server.setRequestHandler(ListPromptsRequestSchema, async () => upstream.listPrompts());
  server.setRequestHandler(GetPromptRequestSchema, async (req) =>
    upstream.getPrompt({ name: req.params.name, arguments: req.params.arguments }),
  );

  const shutdown = async () => {
    try {
      await upstream.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log("stdio server ready");
}

main().catch((err) => {
  log(err instanceof Error ? err.message : err);
  process.exit(1);
});
