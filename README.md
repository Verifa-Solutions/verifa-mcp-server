# Verifa MCP Server

Run identity verification from any MCP client — Claude Desktop, Cursor, Claude Code, or your own agent.
Create verification sessions, hand the person a capture link, screen against sanctions and PEP lists,
read results, and work the review queue, all as tools an agent can call.

```json
{
  "mcpServers": {
    "verifa": {
      "command": "npx",
      "args": ["-y", "@withverifa/mcp-server"],
      "env": { "VERIFA_API_KEY": "vk_sandbox_...", "VERIFA_ENV": "sandbox" }
    }
  }
}
```

That is the whole install. Get a sandbox key at [app.withverifa.com](https://app.withverifa.com) → Developers → API keys
(free, no card, no sales call). Sandbox keys never touch real data and can simulate every verification outcome,
so you can see the full lifecycle in a few minutes — [`examples/id-check`](examples/id-check) does exactly that.

## How it works

This package is deliberately small. It opens one authenticated connection to Verifa's hosted MCP endpoint
(`https://api.withverifa.com/mcp`, streamable HTTP) and forwards `tools/list`, `tools/call`, `prompts/list`
and `prompts/get` over stdio. Nothing is reimplemented here: tool schemas, PII scrubbing, rate limits and
the audit trail all live server-side, so this wrapper never drifts from the product.

If your client already speaks streamable HTTP with OAuth 2.1, you can skip this package and connect to the
hosted endpoint directly — same tools, sign-in instead of an API key.

## Tools

The server exposes 45 tools, grouped into toolsets. By default you get everything except `destructive`.

| Toolset | What an agent can do |
|---|---|
| `sessions` | `create_session`, `get_session`, `list_sessions`, `list_session_events`, `simulate_session` (sandbox), `reprocess_session` |
| `checks` | `list_checks`, `get_check`, `list_check_hits`, `rerun_check` — sanctions, PEP, adverse media, watchlists |
| `identities` | `search_identities`, `list_identities`, `get_identity`, tag / untag |
| `cases` | `list_cases`, `get_case`, `claim_case`, `assign_case`, `add_case_comment`, `approve_case`, `reject_case`, `escalate_case` … |
| `findings` | `list_findings`, `get_finding`, `acknowledge_finding`, `dismiss_finding` |
| `lists` | blocklist and custom list reads and writes |
| `workflows` | `list_workflows`, `get_workflow`, `trigger_workflow`, `list_verification_policies` |
| `org` | `whoami`, `get_usage_stats`, `list_org_users`, `list_api_keys` |
| `search` | `search` / `fetch` for ChatGPT-style connectors |
| `destructive` | `redact_session`, `redact_identity`, `bulk_redact_sessions`, … — **off unless you opt in** |

Every tool is scoped: the API key's scopes cap what the connection can do, whatever toolsets are enabled.
Every call — read or write — writes an audit row that records it was made by an agent and by which key or
OAuth client, so an agent's decision is never mistaken for a human's.

### Narrowing the surface

Fewer tools means less context spent per request and better tool selection. Pick what the job needs:

```json
"env": {
  "VERIFA_API_KEY": "vk_sandbox_...",
  "VERIFA_MCP_TOOLSETS": "sessions,checks",
  "VERIFA_MCP_READ_ONLY": "1"
}
```

| Variable | Effect |
|---|---|
| `VERIFA_API_KEY` | Required. `vk_sandbox_…` or `vk_live_…`. Publishable keys (`vk_pub_…`) are rejected. |
| `VERIFA_ENV` | `sandbox` or `live`. Inferred from the key if omitted; must match it if set. |
| `VERIFA_MCP_TOOLSETS` | Comma-separated toolsets to expose. Default: all except `destructive`. |
| `VERIFA_MCP_READ_ONLY` | `1` hides every tool that writes. |
| `VERIFA_MCP_ALLOW_DESTRUCTIVE` | `1` adds the redaction tools. Each call also needs the `redact:write` scope, a written `reason`, and is capped at 5 per hour per key. Redaction is irreversible by design. |
| `VERIFA_API_URL` | Override the API host (e.g. a staging environment). |

Check what a given configuration exposes without opening a client:

```sh
VERIFA_API_KEY=vk_sandbox_... npx -y @withverifa/mcp-server --check
```

## Try it in five minutes

```sh
git clone https://github.com/withverifa/verifa-mcp-server
cd verifa-mcp-server/examples/id-check
npm install
cp .env.example .env        # paste your sandbox key
npm start                   # approve
npm run review              # the outcome that matters: a human has to decide
```

The demo creates a session, generates the one-time capture link and QR code an integrator would show,
simulates an outcome (no passport needed — sandbox only), and reads the result. It prints the REST calls
in one column and the identical flow driven through this MCP server in the other. Add `--webhooks` with a
public URL (`cloudflared tunnel --url http://localhost:8787` works) to receive the signed webhook deliveries
and see signature verification — the part most integrations get wrong.

## Development

```sh
npm install
npm run build
npm test                                     # unit tests
VERIFA_API_KEY=vk_sandbox_... node dist/index.js --check   # live smoke test
```

Node 20+. Logs go to stderr; stdout is the MCP transport.

## Security

- Use sandbox keys while evaluating. Live keys should be scoped to the toolsets the agent needs.
- The server never stores or logs the API key; it is sent only as a Bearer token to `VERIFA_API_URL`.
- Responses are PII-free by default — the hosted server strips applicant identifiers from tool results
  unless the key holds the relevant scope and the session's sensitive-data window is open.
- Report vulnerabilities via [withverifa.com/security/disclosure](https://withverifa.com/security/disclosure/).

## License

MIT — see [LICENSE](LICENSE).
