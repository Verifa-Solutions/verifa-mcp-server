#!/usr/bin/env node
/**
 * id-check — run a real Verifa identity verification end to end in under five
 * minutes, with no real ID document, and see the same flow driven two ways:
 *
 *   REST   create session → one-time link + QR → simulate outcome → read result
 *   AGENT  the identical steps, executed by an MCP client through
 *          @verifasolutionsinc/mcp-server — what an AI agent sees and calls
 *
 * Usage:
 *   node index.mjs                      # approve, REST + agent side by side
 *   node index.mjs --outcome=require-review
 *   node index.mjs --outcome=decline --rest-only
 *   node index.mjs --webhooks           # also register a receiver (needs a public URL)
 *
 * Env (.env.example): VERIFA_API_KEY (sandbox), VERIFA_API_URL, WEBHOOK_PUBLIC_URL
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VerifaClient, waitForResult } from "./verifa.mjs";
import { startWebhookReceiver, field } from "./webhook.mjs";

// ── tiny .env loader (no dotenv dependency) ────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
for (const f of [resolve(here, ".env"), resolve(here, "../../.env")]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const OUTCOME = args.outcome ?? "approve";
const OUTCOMES = ["approve", "decline", "require-review", "expire"];
if (!OUTCOMES.includes(OUTCOME)) {
  console.error(`--outcome must be one of ${OUTCOMES.join(", ")}`);
  process.exit(2);
}
const API_KEY = process.env.VERIFA_API_KEY;
const API_URL = process.env.VERIFA_API_URL ?? "https://api.withverifa.com";
if (!API_KEY?.startsWith("vk_sandbox_")) {
  console.error("Set VERIFA_API_KEY to a sandbox key (vk_sandbox_…). The demo simulates outcomes, which only sandbox allows.");
  process.exit(2);
}

// ── output helpers ──────────────────────────────────────────────────────────
const W = 50;
const col = (s) => String(s ?? "").padEnd(W).slice(0, W);
const row = (l, r) => console.log(`  ${col(l)}│  ${r ?? ""}`);
const hr = () => console.log(`  ${"─".repeat(W)}┼${"─".repeat(W + 2)}`);
const banner = (t) => console.log(`\n${t}\n${"═".repeat(t.length)}`);

function renderResult(result) {
  if (!result) return ["(no result)"];
  const status = result.status;
  const lines = [];
  if (status === "passed" || status === "approved") lines.push("✓ APPROVED — identity verified");
  else if (status === "failed" || status === "rejected" || status === "declined")
    lines.push(`✗ DECLINED — ${result.rejection_reason ?? result.rejection_reason_code ?? "did not pass"}`);
  else if (status === "needs_review") lines.push("⚠ NEEDS REVIEW — a human decides");
  else if (status === "expired") lines.push("○ EXPIRED — the person never finished");
  else lines.push(`status: ${status}`);
  const checks = result.check_results ?? {};
  for (const [k, v] of Object.entries(checks)) {
    const s = typeof v === "object" && v ? (v.status ?? v.passed) : v;
    lines.push(`  ${k}: ${s}`);
  }
  if (status === "needs_review") {
    lines.push("  → open the case in the dashboard review queue");
    lines.push("    or call approve_case / reject_case from an agent");
  }
  return lines;
}

// ── webhook receiver (optional) ─────────────────────────────────────────────
const received = [];
let endpoint = null;
let server = null;
const client = new VerifaClient({ apiKey: API_KEY, apiUrl: API_URL });

async function setupWebhooks() {
  const publicUrl = process.env.WEBHOOK_PUBLIC_URL;
  if (!publicUrl) {
    console.log("  --webhooks needs WEBHOOK_PUBLIC_URL (Verifa cannot deliver to localhost).");
    console.log("  e.g. run `cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787` and set it.");
    return;
  }
  const path = "/webhooks/verifa";
  const events = ["session.created", "session.link_generated", "session.approved", "session.declined", "session.requires-review", "session.expired"];
  // Create first so we have the secret before the first delivery.
  endpoint = await client.createWebhookEndpoint(`${publicUrl.replace(/\/+$/, "")}${path}`, events);
  const secret = endpoint.secret;
  if (!secret) throw new Error("Endpoint created but no secret returned — is this a sandbox key?");
  server = startWebhookReceiver({
    port: Number(process.env.WEBHOOK_PORT ?? 8787),
    path,
    secret,
    log: (m) => console.log(`  ${m}`),
    onEvent: (payload, meta) => {
      received.push({ payload, meta });
      console.log(`  ✓ webhook ${field(payload, "event")}  (delivery ${meta.deliveryId}, signature ok)`);
    },
  });
}

async function teardownWebhooks() {
  if (endpoint) await client.deleteWebhookEndpoint(endpoint.id).catch(() => {});
  server?.close();
}

// ── REST flow ───────────────────────────────────────────────────────────────
async function restFlow() {
  const steps = [];
  const session = await client.createSession({ external_ref: `demo-${Date.now()}`, metadata: { source: "verifa-mcp-server demo" } });
  steps.push(["POST /sessions", `${session.id}  status=${session.status}`]);

  const link = await client.generateLink(session.id, 30);
  steps.push(["POST /sessions/{id}/generate-one-time-link", link.capture_url]);
  steps.push(["", `+ QR code (${Math.round((link.qr_code_data_url ?? "").length / 1024)} KB data URL)`]);

  await client.simulate(session.id, OUTCOME);
  steps.push([`POST /sessions/{id}/simulate {action:"${OUTCOME}"}`, "sandbox-only; fires the real webhooks"]);

  const result = OUTCOME === "expire" ? await waitForResult(client, session.id, { timeoutMs: 15_000 }).catch(() => null) : await waitForResult(client, session.id);
  const finalSession = await client.getSession(session.id);
  steps.push(["GET /sessions/{id}/result", null]);
  return { session: finalSession, result: result?.status ? result : { status: finalSession.status }, steps };
}

// ── Agent flow (through the MCP server) ─────────────────────────────────────
async function agentFlow() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const serverCmd = (process.env.VERIFA_MCP_SERVER_CMD ?? "npx -y @verifasolutionsinc/mcp-server").split(/\s+/);
  const mcp = new Client({ name: "id-check-demo", version: "0.1.0" });
  await mcp.connect(
    new StdioClientTransport({
      // Published package by default; VERIFA_MCP_SERVER_CMD="node ../../dist/index.js" for a local checkout.
      command: serverCmd[0],
      args: serverCmd.slice(1),
      env: { ...process.env, VERIFA_API_KEY: API_KEY, VERIFA_API_URL: API_URL, VERIFA_ENV: "sandbox" },
      stderr: "ignore",
    }),
  );
  const call = async (name, argsObj) => {
    const r = await mcp.callTool({ name, arguments: argsObj });
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  };

  const steps = [];
  const { tools } = await mcp.listTools();
  steps.push(["tools/list", `${tools.length} tools (no schema written by hand)`]);

  const created = await call("create_session", { external_ref: `demo-agent-${Date.now()}` });
  const sessionId = created.id ?? created.session_id ?? created.session?.id;
  steps.push(["create_session {external_ref}", `${sessionId}`]);

  // The agent hands the link to the person; simulate is the sandbox shortcut.
  const hasSimulate = tools.some((t) => t.name === "simulate_session");
  if (hasSimulate) {
    await call("simulate_session", { session_id: sessionId, action: OUTCOME });
    steps.push([`simulate_session {action:"${OUTCOME}"}`, "same endpoint the REST column used"]);
  } else {
    await client.simulate(sessionId, OUTCOME);
    steps.push([`(REST) simulate "${OUTCOME}"`, "simulate_session not exposed on this server yet"]);
  }

  let session = await call("get_session", { session_id: sessionId });
  for (let i = 0; i < 20 && !["completed", "under_review", "expired"].includes(session.status); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    session = await call("get_session", { session_id: sessionId });
  }
  steps.push(["get_session", `status=${session.status}`]);
  const result = session.result ?? (await client.getResult(sessionId)) ?? { status: session.status };
  await mcp.close();
  return { session, result, steps };
}

// ── main ────────────────────────────────────────────────────────────────────
banner(`Verifa id-check — outcome "${OUTCOME}" in sandbox (${API_URL})`);
if (args.webhooks) await setupWebhooks();

const rest = await restFlow();
const agent = args["rest-only"] ? null : await agentFlow().catch((e) => ({ error: e }));

console.log();
row("REST — what your backend calls", "AGENT — what an MCP client calls");
hr();
const n = Math.max(rest.steps.length, agent?.steps?.length ?? 0);
for (let i = 0; i < n; i++) {
  const l = rest.steps[i] ?? ["", ""];
  const r = agent?.steps?.[i] ?? ["", ""];
  row(l[0], r[0]);
  if (l[1] || r[1]) row(`  ${l[1] ?? ""}`, r[1] ? `  ${r[1]}` : "");
}
if (agent?.error) row("", `agent flow failed: ${agent.error.message}`);
hr();
const lr = renderResult(rest.result);
const ar = agent && !agent.error ? renderResult(agent.result) : [""];
for (let i = 0; i < Math.max(lr.length, ar.length); i++) row(lr[i], ar[i]);

if (args.webhooks) {
  banner("Webhooks");
  await new Promise((r) => setTimeout(r, 4000)); // give the last delivery a moment
  if (!received.length) console.log("  (none received — check WEBHOOK_PUBLIC_URL is reachable from the internet)");
  for (const { payload } of received) console.log(`  ${field(payload, "event")}  session=${field(payload, "session_id")}`);
  await teardownWebhooks();
}

console.log(`\nDashboard: ${API_URL.includes("staging") ? "https://staging.withverifa.com" : "https://app.withverifa.com"}/verifications/${rest.session.id}\n`);
