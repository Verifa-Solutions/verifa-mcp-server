/**
 * Environment → settings. Everything the server needs comes from env vars so a
 * client config is one JSON block with no install step (`npx -y @withverifa/mcp-server`).
 */

export interface Settings {
  apiKey: string;
  env: "sandbox" | "live";
  apiUrl: string;
  /** Hosted MCP endpoint, including toolset / read_only query params. */
  mcpUrl: string;
  toolsets: string[] | null;
  readOnly: boolean;
  allowDestructive: boolean;
}

const DEFAULT_API_URL = "https://api.withverifa.com";

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const apiKey = (env.VERIFA_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "VERIFA_API_KEY is not set. Create a sandbox key at https://app.withverifa.com (Developers → API keys) " +
        "and put it in the server's env block.",
    );
  }
  if (apiKey.startsWith("vk_pub_")) {
    throw new Error("Publishable keys (vk_pub_…) cannot be used with MCP. Use a secret key (vk_sandbox_… or vk_live_…).");
  }

  const keyEnv: "sandbox" | "live" | null = apiKey.startsWith("vk_sandbox_")
    ? "sandbox"
    : apiKey.startsWith("vk_live_")
      ? "live"
      : null;
  const declared = (env.VERIFA_ENV ?? "").trim().toLowerCase();
  let envName: "sandbox" | "live";
  if (declared === "sandbox" || declared === "live") {
    envName = declared;
    if (keyEnv && keyEnv !== envName) {
      throw new Error(`VERIFA_ENV=${envName} but the API key is a ${keyEnv} key. They must match.`);
    }
  } else if (keyEnv) {
    envName = keyEnv;
  } else {
    envName = "sandbox";
  }

  const apiUrl = (env.VERIFA_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");

  const allowDestructive = flag(env, "VERIFA_MCP_ALLOW_DESTRUCTIVE");
  const readOnly = flag(env, "VERIFA_MCP_READ_ONLY");

  let toolsets: string[] | null = null;
  const raw = (env.VERIFA_MCP_TOOLSETS ?? "").trim();
  if (raw) {
    toolsets = raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  // The hosted server hides the `destructive` toolset unless it is named
  // explicitly. Opting in without naming any other toolset means "everything
  // plus destructive", so we ask the server for the full default list too.
  if (allowDestructive) {
    if (toolsets === null) toolsets = [...DEFAULT_TOOLSETS];
    if (!toolsets.includes("destructive")) toolsets.push("destructive");
  }

  const params = new URLSearchParams();
  if (toolsets) params.set("toolsets", toolsets.join(","));
  if (readOnly) params.set("read_only", "1");
  const qs = params.toString();
  const mcpUrl = `${apiUrl}/mcp${qs ? `?${qs}` : ""}`;

  return { apiKey, env: envName, apiUrl, mcpUrl, toolsets, readOnly, allowDestructive };
}

/** Toolsets the hosted server exposes by default (everything except `destructive`). */
export const DEFAULT_TOOLSETS = [
  "org",
  "sessions",
  "identities",
  "cases",
  "checks",
  "lists",
  "findings",
  "workflows",
  "search",
] as const;
