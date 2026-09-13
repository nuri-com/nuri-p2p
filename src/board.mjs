// The board. Offers travel over public Nostr relays that other people run.
// We operate none of them. An offer also survives as a plain file: see toFile/fromFile.
import { ethers } from "ethers";
import { OFFER_KIND, DEFAULT_RELAYS, CHAIN_ID, SEAPORT } from "./constants.mjs";
import { orderHash, signatureMatchesOfferer } from "./offer.mjs";

export const SCHEMA_VERSION = "nuri-p2p/1";

// A note carries the complete signed order, so a reader needs nothing else —
// not us, not an index, not the relay it came from.
export function toNote(signed, { chainId = CHAIN_ID } = {}) {
  const p = signed.parameters;
  const content = JSON.stringify({
    v: SCHEMA_VERSION,
    chainId,
    seaport: SEAPORT,
    order: p,
    signature: signed.signature,
  });
  return {
    kind: OFFER_KIND,
    created_at: Number(p.startTime),
    content,
    tags: [
      ["d", orderHash(p)],                       // replaceable: one event per order
      ["k", "swap"],
      ["expiration", String(p.endTime)],         // NIP-40: relays may drop it after this
      ["chain", String(chainId)],
      ["gives", p.offer[0].token, p.offer[0].startAmount],
      ["wants", p.consideration[0].token, p.consideration[0].startAmount],
      ["v", SCHEMA_VERSION],
    ],
  };
}

// Parse a note back into a signed order. Returns { ok, reason, signed }.
// Never throws on hostile input: a bad note is a skipped note, not a crash.
export function fromNote(note, { chainId = CHAIN_ID, now = Math.floor(Date.now() / 1000) } = {}) {
  const bad = (reason) => ({ ok: false, reason });
  if (!note || note.kind !== OFFER_KIND) return bad("wrong_kind");

  let body;
  try { body = JSON.parse(note.content); } catch { return bad("unparseable"); }
  if (body?.v !== SCHEMA_VERSION) return bad("unknown_version");
  if (body.chainId !== chainId) return bad("wrong_chain");
  if (!body.seaport || body.seaport.toLowerCase() !== SEAPORT.toLowerCase()) return bad("unknown_settlement_contract");

  const order = body.order;
  if (!order?.offer?.length || !order?.consideration?.length) return bad("malformed_order");
  if (order.offer.length !== 1 || order.consideration.length !== 1) return bad("unsupported_shape");
  if (order.zone !== "0x0000000000000000000000000000000000000000") return bad("has_zone");
  if (order.conduitKey !== "0x" + "00".repeat(32)) return bad("has_conduit");
  if (Number(order.endTime) <= now) return bad("expired");

  const signed = { parameters: order, signature: body.signature };
  if (!signatureMatchesOfferer(signed, chainId, body.seaport)) return bad("bad_signature");

  return { ok: true, signed, hash: orderHash(order) };
}

// Offers as files. This is the escape hatch: relays can censor, a file cannot.
export const toFile = (signed) => JSON.stringify(toNote(signed), null, 2);
export const fromFile = (text, opts) => {
  try { return fromNote(JSON.parse(text), opts); }
  catch { return { ok: false, reason: "unparseable" }; }
};

// --- relay I/O -------------------------------------------------------------
// Loaded lazily so that everything above works with no network and no nostr-tools.

async function tools() {
  const { SimplePool, finalizeEvent, generateSecretKey, getPublicKey } = await import("nostr-tools/pure")
    .catch(async () => await import("nostr-tools"));
  return { SimplePool, finalizeEvent, generateSecretKey, getPublicKey };
}

// Publishing identity is throwaway and unrelated to the wallet: the Nostr key
// says who posted, the EIP-712 signature says who may spend. Never conflate them.
export async function publish(signed, { relays = DEFAULT_RELAYS, secretKey } = {}) {
  const { SimplePool, finalizeEvent, generateSecretKey } = await tools();
  const sk = secretKey ?? generateSecretKey();
  const event = finalizeEvent(toNote(signed), sk);
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, event));
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    return { event, accepted, attempted: relays.length };
  } finally {
    pool.close(relays);
  }
}

export async function fetchOffers({ relays = DEFAULT_RELAYS, limit = 50, chainId = CHAIN_ID, timeoutMs = 8000 } = {}) {
  const { SimplePool } = await tools();
  const pool = new SimplePool();
  try {
    const events = await pool.querySync(relays, { kinds: [OFFER_KIND], limit }, { maxWait: timeoutMs });
    const seen = new Set();
    const offers = [];
    for (const e of events) {
      const parsed = fromNote(e, { chainId });
      if (!parsed.ok || seen.has(parsed.hash)) continue;
      seen.add(parsed.hash);
      offers.push({ ...parsed, event: e });
    }
    return offers;
  } finally {
    pool.close(relays);
  }
}
