/**
 * Webhook receiver with signature verification.
 *
 * Verifa signs every delivery Stripe-style:
 *   X-Verifa-Signature: t=<unix_ts>,v1=<hex hmac-sha256>
 *   signed payload   = `${t}.${raw body}`
 * Reject anything older than a few minutes so a captured delivery cannot be
 * replayed. This is where most integration bugs live — copy this file.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const TOLERANCE_SECONDS = 300;

export function verifySignature(rawBody, secret, header, { tolerance = TOLERANCE_SECONDS, now = Date.now() / 1000 } = {}) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2)));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(now - t) > tolerance) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Webhook payloads follow the org's key inflection; accept both spellings. */
export function field(payload, snake) {
  if (payload[snake] !== undefined) return payload[snake];
  const kebab = snake.replaceAll("_", "-");
  if (payload[kebab] !== undefined) return payload[kebab];
  const camel = snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  return payload[camel];
}

/**
 * Start a local receiver. `onEvent(payload, meta)` is called only for
 * deliveries whose signature verifies. Returns the http.Server.
 */
export function startWebhookReceiver({ port = 8787, path = "/webhooks/verifa", secret, onEvent, log = console.log }) {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const sig = req.headers["x-verifa-signature"];
      const deliveryId = req.headers["x-verifa-delivery-id"];
      if (!verifySignature(raw, secret, sig)) {
        log(`✗ webhook ${deliveryId ?? "?"} rejected — bad signature`);
        res.writeHead(401).end();
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }
      // Acknowledge fast; Verifa retries on non-2xx.
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
      onEvent?.(payload, { deliveryId, receivedAt: new Date() });
    });
  });
  server.listen(port, () => log(`webhook receiver listening on http://localhost:${port}${path}`));
  return server;
}
