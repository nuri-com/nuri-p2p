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

// Seconds per block, per chain. Deadlines live in block heights — that is what
// both OP_CHECKLOCKTIMEVERIFY and ERC20Swap.sol compare against — but a height on
// Bitcoin and a height on Base are not the same kind of number, and comparing
// them directly is meaningless. Everything is converted to wall clock before any
// ordering is decided.
export const BLOCK_SECONDS = {
  [CHAINS.bitcoin]: 600,
  [CHAINS.lightning]: 600,
  "eip155:8453": 2,
  "eip155:1": 12,
};

// How much later the first locker's deadline must be. It must cover: noticing the
// secret on chain, building a claim, and getting it confirmed — on the SLOWER of
// the two chains, during a fee spike, with some room left over. Two Bitcoin blocks
// plus an hour is the floor.
export const MIN_GAP_SECONDS = 2 * 600 + 3600;

/**
 * The inequality that keeps money safe.
 *
 * The maker publishes the hash, so the maker holds the secret, so the maker locks
 * FIRST and claims FIRST. The order that follows is forced:
 *
 *   maker locks  ->  taker locks  ->  maker claims (reveals)  ->  taker claims
 *
 * The taker is last, so the taker needs their refund deadline to arrive FIRST.
 * If it were the other way round the maker could let their own deadline pass,
 * refund their lock, and still claim the taker's — collecting both sides. That
 * is the whole reason this function exists.
 *
 * Deadlines are block heights on their own chains, so the caller must say which
 * chain each one lives on and how high that chain currently is.
 */
export function timelocksAreSafe(terms, { giveChain, wantChain, giveHeight, wantHeight } = {}) {
  const { makerRefundAt, takerRefundAt } = terms ?? {};
  if (!Number.isInteger(makerRefundAt) || !Number.isInteger(takerRefundAt)) return false;

  // The maker locks what they give; the taker locks what the maker wants.
  const makerSeconds = BLOCK_SECONDS[giveChain];
  const takerSeconds = BLOCK_SECONDS[wantChain];
  if (!makerSeconds || !takerSeconds) return false;
  if (!Number.isInteger(giveHeight) || !Number.isInteger(wantHeight)) return false;

  // Both deadlines expressed as "seconds from now", on their own chain's clock.
  const makerIn = (makerRefundAt - giveHeight) * makerSeconds;
  const takerIn = (takerRefundAt - wantHeight) * takerSeconds;

  // A deadline already in the past is not a deadline.
  if (makerIn <= 0 || takerIn <= 0) return false;

  // MIN_GAP_SECONDS is a constant on purpose. It used to be a parameter with a
  // default, which meant an intent could carry `minGapSeconds: 0` in its own terms
  // and switch off the check that exists to protect whoever fills it.
  return takerIn + MIN_GAP_SECONDS <= makerIn;
}

export default register({
  id: "htlc-v1",

  parse(intent, { now, heights }) {
    const t = intent?.terms;
    const bad = (reason) => ({ ok: false, reason });
    if (!t) return bad("malformed_terms");
    if (!SHA256_HEX.test(String(t.hash ?? "").replace(/^0x/, ""))) return bad("bad_payment_hash");
    if (!Number.isInteger(t.makerRefundAt) || !Number.isInteger(t.takerRefundAt)) return bad("missing_timelocks");

    // One side must be a chain that cannot settle atomically with the other;
    // otherwise use a method that does it in one transaction.
    const giveChain = intent.give?.chain;
    const wantChain = intent.want?.chain;
    if (giveChain === wantChain) return bad("same_chain_use_atomic_method");
    if (![giveChain, wantChain].some((c) => c === CHAINS.bitcoin || c === CHAINS.lightning)) return bad("no_htlc_leg");
    if (!BLOCK_SECONDS[giveChain] || !BLOCK_SECONDS[wantChain]) return bad("unknown_chain_timing");

    // Deadlines are block heights, so judging them needs to know how high each
    // chain is right now. Without that we cannot tell safe from unsafe, and
    // guessing would be the dangerous answer.
    const giveHeight = heights?.[giveChain];
    const wantHeight = heights?.[wantChain];
    if (!Number.isInteger(giveHeight) || !Number.isInteger(wantHeight)) return bad("need_chain_heights");

    if (!timelocksAreSafe(t, { giveChain, wantChain, giveHeight, wantHeight })) return bad("unsafe_timelocks");
    if (Number.isInteger(intent.expiresAt) && intent.expiresAt <= now) return bad("expired");

    // Readable and well-formed, but nothing can execute it yet. Saying so is the
    // point: a reader lists it, a taker is told plainly why it cannot act.
    return { ok: false, reason: "no_adapter_yet", readable: true, id: intent.id };
  },

  describe: () => "Two locks, one secret. You must be online to claim, or refund after the deadline.",
});