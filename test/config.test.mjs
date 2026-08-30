import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSettings } from "../dist/config.js";

test("infers env from key prefix", () => {
  const s = loadSettings({ VERIFA_API_KEY: "vk_sandbox_abc" });
  assert.equal(s.env, "sandbox");
  assert.equal(s.mcpUrl, "https://api.withverifa.com/mcp");
});

test("rejects env/key mismatch", () => {
  assert.throws(() => loadSettings({ VERIFA_API_KEY: "vk_live_abc", VERIFA_ENV: "sandbox" }), /must match/);
});

test("rejects publishable keys", () => {
  assert.throws(() => loadSettings({ VERIFA_API_KEY: "vk_pub_sandbox_abc" }), /Publishable/);
});

test("builds toolset + read_only query", () => {
  const s = loadSettings({ VERIFA_API_KEY: "vk_sandbox_a", VERIFA_MCP_TOOLSETS: "sessions, checks", VERIFA_MCP_READ_ONLY: "1" });
  assert.equal(s.mcpUrl, "https://api.withverifa.com/mcp?toolsets=sessions%2Cchecks&read_only=1");
});

test("destructive opt-in adds the toolset without dropping defaults", () => {
  const s = loadSettings({ VERIFA_API_KEY: "vk_sandbox_a", VERIFA_MCP_ALLOW_DESTRUCTIVE: "true" });
  assert.ok(s.toolsets?.includes("destructive"));
  assert.ok(s.toolsets?.includes("sessions"));
});
