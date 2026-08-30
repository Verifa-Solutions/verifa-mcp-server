/**
 * Minimal Verifa REST client for the demo. No dependencies — global fetch.
 *
 * Every response is requested in snake_case (`Key-Inflection: snake`) so the
 * field names match the API reference. Org defaults may be kebab-case.
 */

export class VerifaClient {
  constructor({ apiKey, apiUrl = "https://api.withverifa.com" }) {
    if (!apiKey) throw new Error("VERIFA_API_KEY is required");
    this.apiKey = apiKey;
    this.base = apiUrl.replace(/\/+$/, "") + "/api/v1";
  }

  async request(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        "Key-Inflection": "snake",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const detail = data?.detail ?? data?.error ?? text;
      const err = new Error(`${method} ${path} → ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  /** POST /sessions — nothing is required; external_ref helps you join later. */
  createSession(body = {}) {
    return this.request("POST", "/sessions", body);
  }

  /** POST /sessions/{id}/generate-one-time-link — capture URL + QR data URL. */
  generateLink(sessionId, expiresInMinutes = 60) {
    return this.request("POST", `/sessions/${sessionId}/generate-one-time-link`, {
      expires_in_minutes: expiresInMinutes,
    });
  }

  getSession(sessionId) {
    return this.request("GET", `/sessions/${sessionId}`);
  }

  /** GET /sessions/{id}/result — 404 "No result yet" until processing finishes. */
  async getResult(sessionId) {
    try {
      return await this.request("GET", `/sessions/${sessionId}/result`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * POST /sessions/{id}/simulate — sandbox only.
   * action: approve | decline | require-review | expire
   * Writes a real result row and fires real webhooks, so the rest of your
   * integration cannot tell it apart from a genuine capture.
   */
  simulate(sessionId, action) {
    return this.request("POST", `/sessions/${sessionId}/simulate`, { action });
  }

  /** POST /webhooks/endpoints — sandbox endpoints return their signing secret. */
  createWebhookEndpoint(url, events, label = "verifa-mcp-server demo") {
    return this.request("POST", "/webhooks/endpoints", { url, enabled_events: events, label });
  }

  deleteWebhookEndpoint(id) {
    return this.request("DELETE", `/webhooks/endpoints/${id}`);
  }

  listPolicies() {
    return this.request("GET", "/verification-policies");
  }
}

/** Poll until a result exists or the session reaches a terminal status. */
export async function waitForResult(client, sessionId, { timeoutMs = 60_000, intervalMs = 1_500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.getResult(sessionId);
    if (result) return result;
    const session = await client.getSession(sessionId);
    if (session.status === "expired" || session.status === "failed") return { status: session.status, session };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for a result on ${sessionId}`);
}
