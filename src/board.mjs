// The board: intents travel over public Nostr relays that other people run,
// or as plain files. We operate none of it.
//
// An intent is settlement-agnostic. The envelope says WHAT (give this, want that)
// in a form anyone can filter on; `settle` names HOW, and the method owns the rest.
// A reader that does not know a method skips the intent instead of guessing.
import { OFFER_KIND, DEFAULT_RELAYS } from "./constants.mjs";
import { get as method, known } from "./settle.mjs";
import "./settle-seaport.mjs"; // registers seaport-1.6

export const SCHEMA_VERSION = "nuri-p2p/2";

export function toNote(intent) {
  const content = JSON.stringify({ v: SCHEMA_VERSION, ...intent });
  return {
    kind: OFFER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [
      ["d", intent.id],
      ["k", "intent"],
      ["settle", intent.settle],
      ["expiration", String(intent.expiry)],   // NIP-40: relays may drop it themselves
      ["gives", intent.give.chain, intent.give.asset, intent.give.amount],
      ["wants", intent.want.chain, intent.want.asset, intent.want.amount],
      ["v", SCHEMA_VERSION],
    ],
  };
}

// Returns { ok, reason } or { ok:true, intent, settled }. Never throws on hostile input.
export function fromNote(note, { now = Math.floor(Date.now() / 1000) } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  if (!note || note.kind !== OFFER_KIND) return bad("wrong_kind");

  let body;
  try { body = JSON.parse(note.content); } catch { return bad("unparseable"); }
  if (body?.v !== SCHEMA_VERSION) return bad("unknown_version");
  for (const f of ["settle", "give", "want", "expiry", "terms", "proof", "id"]) {
    if (body[f] === undefined) return bad("malformed_intent");
  }
  for (const leg of [body.give, body.want]) {
    if (!leg?.chain || !leg?.asset || !leg?.amount) return bad("malformed_leg");
  }
  if (Number(body.expiry) <= now) return bad("expired");

  const m = method(body.settle);
  if (!m) return bad("unknown_settlement_method");

  const parsed = m.parse(body, { now });
  if (!parsed.ok) return parsed;
  if (parsed.id !== body.id) return bad("id_disagrees_with_terms");

  return { ok: true, intent: body, settled: parsed, method: m };
}

// Intents as files. Relays can censor; a file cannot.
export const toFile = (intent) => JSON.stringify(toNote(intent), null, 2);
export const fromFile = (text, opts) => {
  try { return fromNote(JSON.parse(text), opts); }
  catch { return { ok: false, reason: "unparseable" }; }
};

export { known as knownMethods };

// --- relay I/O -------------------------------------------------------------
// Imported lazily, so everything above works offline and without nostr-tools.

async function tools() {
  return import("nostr-tools/pure").catch(() => import("nostr-tools"));
}

// The Nostr key says who posted. The intent's own proof says who may spend.
// Never conflate them: a throwaway posting identity is fine and intended.
export async function publish(intent, { relays = DEFAULT_RELAYS, secretKey } = {}) {
  const { SimplePool, finalizeEvent, generateSecretKey } = await tools();
  const event = finalizeEvent(toNote(intent), secretKey ?? generateSecretKey());
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, event));
    return { event, accepted: results.filter((r) => r.status === "fulfilled").length, attempted: relays.length };
  } finally { pool.close(relays); }
}

// Ask for intents. `settle` filters to methods you can actually act on.
export async function fetchIntents({ relays = DEFAULT_RELAYS, limit = 50, settle, timeoutMs = 8000 } = {}) {
  const { SimplePool } = await tools();
  const pool = new SimplePool();
  try {
    const filter = { kinds: [OFFER_KIND], limit };
    if (settle) filter["#settle"] = Array.isArray(settle) ? settle : [settle];
    const events = await pool.querySync(relays, filter, { maxWait: timeoutMs });
    const seen = new Set(), out = [];
    for (const e of events) {
      const r = fromNote(e);
      if (!r.ok || seen.has(r.intent.id)) continue;
      seen.add(r.intent.id);
      out.push({ ...r, event: e });
    }
    return out;
  } finally { pool.close(relays); }
}
