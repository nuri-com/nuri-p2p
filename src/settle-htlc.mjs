// Settlement method: paired HTLC, Bitcoin or Lightning on one side, EVM on the other.
//
// This is the honest cross-chain leg. It is NOT one transaction: each side locks
// funds behind the same hash, the claimer reveals the secret, and the other side
// uses that revealed secret to claim. Whoever goes offline at the wrong moment
// must refund within a deadline.
//
// It is registered because the RULE holds — any taker may fill it, no operator,
// no allowlist — and refused as unfillable until its adapters exist. A method that
// lies about being ready is worse than a method that says "not yet".
import { register, CHAINS } from "./settle.mjs";

const SHA256_HEX = /^[0-9a-f]{64}$/i;

// The inequality that keeps money safe. The taker locks second and must be able to
// refund BEFORE the maker can, or the maker can claim and leave the taker stranded.
export function timelocksAreSafe({ makerRefundAt, takerRefundAt, minGapSeconds = 7200 }) {
  return takerRefundAt + minGapSeconds <= makerRefundAt;
}

export default register({
  id: "htlc-v1",

  parse(intent, { now }) {
    const t = intent?.terms;
    const bad = (reason) => ({ ok: false, reason });
    if (!t) return bad("malformed_terms");
    if (!SHA256_HEX.test(String(t.hash ?? "").replace(/^0x/, ""))) return bad("bad_payment_hash");
    if (!Number.isInteger(t.makerRefundAt) || !Number.isInteger(t.takerRefundAt)) return bad("missing_timelocks");
    if (t.makerRefundAt <= now) return bad("expired");
    if (!timelocksAreSafe(t)) return bad("unsafe_timelocks");

    // One side must be a chain that cannot settle atomically with the other;
    // otherwise use a method that does it in one transaction.
    const chains = [intent.give?.chain, intent.want?.chain];
    if (chains[0] === chains[1]) return bad("same_chain_use_atomic_method");
    if (!chains.some((c) => c === CHAINS.bitcoin || c === CHAINS.lightning)) return bad("no_htlc_leg");

    // Readable and well-formed, but nothing can execute it yet. Saying so is the
    // point: a reader lists it, a taker is told plainly why it cannot act.
    return { ok: false, reason: "no_adapter_yet", readable: true, id: intent.id };
  },

  describe: () => "Two locks, one secret. You must be online to claim, or refund after the deadline.",
});
