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
    // Relays index ONLY single-letter tags (NIP-01). A filter on a longer name is
    // rejected outright — "unindexed tag filter" — so the settlement method has to
    // live under a single letter or clients cannot ask for what they can execute.
    tags: [
      ["d", intent.id],
      ["k", "intent"],
      ["m", intent.settle],                    // m = method; the one filterable field
      ["expiration", String(intent.expiry)],   // NIP-40: relays may drop it themselves
      ["g", intent.give.chain, intent.give.asset, intent.give.amount],
      ["w", intent.want.chain, intent.want.asset, intent.want.amount],
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

// Only the signing half of nostr-tools: that part is cryptography and we do not
// reimplement it. Relay I/O is a WebSocket and a JSON array, so it is written here —
// nostr-tools' own pool overflows the stack when one relay refuses the connection,
// and a dead relay must never take the other two down with it.
const signing = () => import("nostr-tools/pure");

// One relay, one job, one hard deadline. Resolves with whatever it got; never rejects,
// because a relay being down is an ordinary Tuesday, not an error the caller handles.
function ask(url, frames, { timeoutMs, collect }) {
  return new Promise((resolve) => {
    const got = [];
    let ws, done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already gone */ }
      resolve({ url, ok, events: got });
    };
    const timer = setTimeout(() => finish(got.length > 0), timeoutMs);
    try { ws = new WebSocket(url); } catch { return finish(false); }
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(got.length > 0 || done);
    ws.onopen = () => { for (const f of frames) ws.send(JSON.stringify(f)); };
    ws.onmessage = (m) => {
      let d;
      try { d = JSON.parse(m.data); } catch { return; }
      if (d[0] === "EVENT" && collect) got.push(d[2]);
      if (d[0] === "EOSE") return finish(true);
      if (d[0] === "OK") return finish(d[2] === true);       // relay accepted our event
      if (d[0] === "CLOSED" || d[0] === "NOTICE") return finish(false);
    };
  });
}

// The Nostr key says who posted. The intent's own proof says who may spend.
// Never conflate them: a throwaway posting identity is fine and intended.
export async function publish(intent, { relays = DEFAULT_RELAYS, secretKey, timeoutMs = 8000 } = {}) {
  const { finalizeEvent, generateSecretKey } = await signing();
  const event = finalizeEvent(toNote(intent), secretKey ?? generateSecretKey());
  const results = await Promise.all(
    relays.map((r) => ask(r, [["EVENT", event]], { timeoutMs, collect: false })));
  return {
    event,
    accepted: results.filter((r) => r.ok).length,
    attempted: relays.length,
    byRelay: Object.fromEntries(results.map((r) => [r.url, r.ok])),
  };
}

// Ask for intents. `settle` filters to methods you can actually act on, so a client
// never downloads rails it cannot use.
export async function fetchIntents({ relays = DEFAULT_RELAYS, limit = 50, settle, timeoutMs = 8000 } = {}) {
  const filter = { kinds: [OFFER_KIND], limit };
  if (settle) filter["#m"] = Array.isArray(settle) ? settle : [settle];
  const results = await Promise.all(
    relays.map((r) => ask(r, [["REQ", "q", filter]], { timeoutMs, collect: true })));

  const seen = new Set(), out = [];
  for (const { events } of results) {
    for (const e of events) {
      const r = fromNote(e);
      if (!r.ok || seen.has(r.intent.id)) continue;
      seen.add(r.intent.id);
      out.push({ ...r, event: e });
    }
  }
  return out;
}
