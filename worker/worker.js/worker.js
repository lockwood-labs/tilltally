/*
 * TillTally sync Worker (Cloudflare Workers + D1, free tier).
 *
 * Deliberately tiny: it stores ONE JSON dataset per household code and
 * serves it to any phone that presents that code. The code is the key —
 * treat it like a shared house key: don't post it publicly.
 *
 * API:
 *   POST /api/households            -> { code }            (create household)
 *   GET  /api/state                 -> { code, data, updatedAt }   header: X-Household-Code
 *   PUT  /api/state  { data }       -> { ok, updatedAt }           header: X-Household-Code
 *   GET  /                          -> { ok: true, service: "tilltally" }
 *
 * Sync model is whole-dataset, last-write-wins. The dataset is small (a
 * household's paychecks, spends and bills), and the app re-pulls on open,
 * so two phones converge on the newest copy. It is not a merge engine:
 * simultaneous edits on both phones at the same moment can overwrite each
 * other — pull before editing if both of you are in the app at once.
 */

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L confusion

function makeCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Household-Code"
    }
  });
}

async function findHousehold(env, code) {
  return env.DB.prepare("SELECT code, data, updated_at FROM households WHERE code = ?")
    .bind(code)
    .first();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return json({}, 204);

    if (url.pathname === "/" && request.method === "GET") {
      return json({ ok: true, service: "tilltally" });
    }

    if (url.pathname === "/api/households" && request.method === "POST") {
      // A few retries against a code collision.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeCode();
        const existing = await findHousehold(env, code);
        if (existing) continue;
        const now = new Date().toISOString();
        await env.DB.prepare("INSERT INTO households (code, data, updated_at) VALUES (?, NULL, ?)")
          .bind(code, now)
          .run();
        return json({ code });
      }
      return json({ error: "Could not allocate a household code, try again" }, 500);
    }

    if (url.pathname === "/api/state") {
      const code = (request.headers.get("X-Household-Code") || "").trim().toUpperCase();
      if (!code) return json({ error: "Missing X-Household-Code header" }, 400);
      const row = await findHousehold(env, code);
      if (!row) return json({ error: "Unknown household code" }, 404);

      if (request.method === "GET") {
        return json({
          code: row.code,
          data: row.data ? JSON.parse(row.data) : null,
          updatedAt: row.updated_at
        });
      }

      if (request.method === "PUT") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Body must be JSON" }, 400);
        }
        if (!body || typeof body !== "object" || !("data" in body)) {
          return json({ error: "Body must be { data: <dataset> }" }, 400);
        }
        const serialized = JSON.stringify(body.data);
        if (serialized.length > 900000) {
          return json({ error: "Dataset too large" }, 413);
        }
        const now = new Date().toISOString();
        await env.DB.prepare("UPDATE households SET data = ?, updated_at = ? WHERE code = ?")
          .bind(serialized, now, code)
          .run();
        return json({ ok: true, updatedAt: now });
      }

      return json({ error: "Method not allowed" }, 405);
    }

    return json({ error: "Not found" }, 404);
  }
};
