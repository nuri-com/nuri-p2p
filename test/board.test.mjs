// The methods layer is the product claim: a new rail must be addable without
// touching the board, the page, or anybody else's client. These tests prove that.
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildOrder, signOrder } from "../src/offer.mjs";
import { toNote, fromNote, toFile, fromFile, SCHEMA_VERSION, knownMethods } from "../src/board.mjs";
import seaport from "../src/settle-seaport.mjs";
import htlc, { timelocksAreSafe } from "../src/settle-htlc.mjs";
import { CHAINS } from "../src/settle.mjs";
import { OFFER_KIND } from "../src/constants.mjs";

const alice = new ethers.Wallet("0x" + "11".repeat(32));
const NOW = 1_800_000_000;
const read = (note, at = NOW + 1) => fromNote(note, { now: at });

const anIntent = async (over = {}) => seaport.fromSigned(await signOrder(alice, buildOrder({
  offerer: alice.address,
  give: { token: "USDC", amount: "1.0" },
  want: { token: "EURC", amount: "0.92" },
  startTime: NOW, salt: "0x" + "ab".repeat(32), ...over,
})));

test("an intent says what, not how — the method is a name", async () => {
  const i = await anIntent();
  assert.equal(i.settle, "seaport-1.6");
  assert.equal(i.give.chain, CHAINS.base);
  assert.equal(i.give.amount, "1000000");
  assert.equal(i.want.amount, "920000");
  assert.ok(i.terms, "how it settles lives in terms");
});

test("the envelope is filterable without understanding the method", async () => {
  const tags = Object.fromEntries(toNote(await anIntent()).tags.map(([k, ...v]) => [k, v]));
  assert.equal(tags.m[0], "seaport-1.6");
  assert.equal(tags.g[0], CHAINS.base);
  assert.equal(tags.k[0], "intent");
});

test("every filterable tag is single-letter, or relays reject the query", async () => {
  // Learned the hard way: nos.lol answers "unindexed tag filter" and closes the
  // subscription. A multi-letter tag name is silently useless for discovery.
  const filterable = ["d", "k", "m", "g", "w", "v"];
  const names = toNote(await anIntent()).tags.map(([k]) => k);
  for (const n of names) {
    if (n === "expiration") continue; // NIP-40, read by relays, never filtered on
    assert.match(n, /^[a-zA-Z]$/, `tag "${n}" cannot be filtered on`);
    assert.ok(filterable.includes(n), `unexpected tag "${n}"`);
  }
});

test("round trip keeps an intent fillable", async () => {
  const r = read(toNote(await anIntent()));
  assert.ok(r.ok, r.reason);
  assert.equal(r.method.id, "seaport-1.6");
});

test("works as a file, with no relay at all", async () => {
  const r = fromFile(toFile(await anIntent()), { now: NOW + 1 });
  assert.ok(r.ok, r.reason);
});

test("an unknown method is skipped, not guessed at", async () => {
  const note = toNote(await anIntent());
  const body = JSON.parse(note.content);
  body.settle = "some-future-rail";
  assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, "unknown_settlement_method");
});

test("the summary cannot lie about the terms", async () => {
  // The attack: advertise a bargain in the part readers filter on, settle the real
  // order. The id stays correct, so only the summary check can catch this.
  for (const lie of [
    (b) => { b.want.amount = "1"; },
    (b) => { b.give.amount = "999000000"; },
    (b) => { b.give.asset = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42"; },
  ]) {
    const note = toNote(await anIntent());
    const body = JSON.parse(note.content);
    lie(body);
    assert.equal(read({ ...note, content: JSON.stringify(body) }).reason,
      "summary_disagrees_with_terms", JSON.stringify(body.give) + JSON.stringify(body.want));
  }
});

test("the id cannot lie about the terms", async () => {
  const note = toNote(await anIntent());
  const body = JSON.parse(note.content);
  body.id = "0x" + "ff".repeat(32);
  assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, "id_disagrees_with_terms");
});

test("hostile input is refused with a reason, never thrown", async () => {
  for (const [note, reason] of [
    [null, "wrong_kind"],
    [{ kind: OFFER_KIND, content: "nope" }, "unparseable"],
    [{ kind: OFFER_KIND, content: JSON.stringify({ v: "nuri-p2p/1" }) }, "unknown_version"],
    [{ kind: OFFER_KIND, content: JSON.stringify({ v: SCHEMA_VERSION }) }, "malformed_intent"],
  ]) assert.equal(read(note).reason, reason);
});

test("an expired intent is refused before its method is consulted", async () => {
  const note = toNote(await anIntent({ expirySeconds: 60 }));
  assert.equal(fromNote(note, { now: NOW + 61 }).reason, "expired");
});

// --- the second method: this is what makes it a marketplace, not one product ---

test("a Bitcoin method registers without the board knowing anything about Bitcoin", () => {
  assert.deepEqual(knownMethods().sort(), ["htlc-v1", "seaport-1.6"]);
  assert.equal(htlc.id, "htlc-v1");
});

// Deadlines are block heights on their own chains. These are real-ish heights, and
// the gap between them is the point: Bitcoin moves ~300x slower than Base, so the
// same number means wildly different amounts of time.
const BTC_TIP = 967000;
const BASE_TIP = 51_000_000;
const HEIGHTS = { [CHAINS.bitcoin]: BTC_TIP, [CHAINS.base]: BASE_TIP, [CHAINS.lightning]: BTC_TIP };

// maker gives BTC (locks first, needs the LATER deadline), taker gives USDC on Base.
const crossChain = (over = {}) => ({
  v: SCHEMA_VERSION, settle: "htlc-v1", by: alice.address, id: "0x" + "aa".repeat(32),
  give: { chain: CHAINS.bitcoin, asset: "btc", amount: "100000" },
  want: { chain: CHAINS.base, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "100000000" },
  expiry: NOW + 86400,
  terms: {
    hash: "a".repeat(64),
    makerRefundAt: BTC_TIP + 48,          // ~8 hours of Bitcoin blocks
    takerRefundAt: BASE_TIP + 5400,       // ~3 hours of Base blocks
  },
  proof: "0x00",
  ...over,
});

const readCross = (i) => fromNote({ kind: OFFER_KIND, content: JSON.stringify(i) }, { now: NOW + 1, heights: HEIGHTS });

test("cross-chain intents are readable by a client that cannot execute them", () => {
  const r = readCross(crossChain());
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_adapter_yet");
  assert.equal(r.readable, true, "readable, but honestly not executable yet");
});

test("timelock safety is judged in seconds, not in raw block numbers", () => {
  const safe = (terms) => timelocksAreSafe(terms, {
    giveChain: CHAINS.bitcoin, wantChain: CHAINS.base, giveHeight: BTC_TIP, wantHeight: BASE_TIP,
  });

  // Maker on Bitcoin ~8h, taker on Base ~3h: the taker can refund first, with room.
  assert.ok(safe({ makerRefundAt: BTC_TIP + 48, takerRefundAt: BASE_TIP + 5400 }));

  // Reversed: the maker's deadline lands first. The maker could refund and still
  // claim the taker's lock, taking both sides.
  assert.equal(safe({ makerRefundAt: BTC_TIP + 6, takerRefundAt: BASE_TIP + 20000 }), false);

  // The bug this replaced: comparing heights directly. takerRefundAt is a much
  // SMALLER number than makerRefundAt here, which the old check called safe —
  // but 1 Bitcoin block is 10 minutes and 1 Base block is 2 seconds, so the
  // taker's deadline is actually ~11 days away and the maker's is ~10 minutes.
  assert.equal(safe({ makerRefundAt: BTC_TIP + 1, takerRefundAt: BASE_TIP + 500000 }), false);

  // A deadline already in the past is not a deadline.
  assert.equal(safe({ makerRefundAt: BTC_TIP - 1, takerRefundAt: BASE_TIP + 5400 }), false);
  assert.equal(safe({ makerRefundAt: BTC_TIP + 48, takerRefundAt: BASE_TIP - 1 }), false);

  // Equal wall-clock deadlines are a race, not a swap.
  assert.equal(safe({ makerRefundAt: BTC_TIP + 6, takerRefundAt: BASE_TIP + 1800 }), false);

  // A gap that exists but is too small to notice a reveal and get a claim mined.
  assert.equal(safe({ makerRefundAt: BTC_TIP + 7, takerRefundAt: BASE_TIP + 1800 }), false);
});

test("an intent cannot switch off the check that protects whoever fills it", () => {
  // minGapSeconds used to be a parameter with a default, so terms carrying
  // minGapSeconds: 0 disabled it. It is a constant now; extra fields are ignored.
  const withOverride = crossChain();
  withOverride.terms = { ...withOverride.terms, makerRefundAt: BTC_TIP + 6, takerRefundAt: BASE_TIP + 1790, minGapSeconds: 0 };
  assert.equal(readCross(withOverride).reason, "unsafe_timelocks");
});

test("without chain heights an HTLC intent is refused, not guessed at", () => {
  const r = fromNote({ kind: OFFER_KIND, content: JSON.stringify(crossChain()) }, { now: NOW + 1 });
  assert.equal(r.reason, "need_chain_heights");
  // Partial knowledge is still not knowledge.
  const half = fromNote({ kind: OFFER_KIND, content: JSON.stringify(crossChain()) }, { now: NOW + 1, heights: { [CHAINS.bitcoin]: BTC_TIP } });
  assert.equal(half.reason, "need_chain_heights");
});

test("a chain whose block time we do not know is refused", () => {
  const i = crossChain();
  i.want = { chain: "eip155:999999", asset: "0x1", amount: "1" };
  const r = fromNote({ kind: OFFER_KIND, content: JSON.stringify(i) }, {
    now: NOW + 1, heights: { ...HEIGHTS, "eip155:999999": 1000 },
  });
  assert.equal(r.reason, "unknown_chain_timing");
});

test("an HTLC intent with dangerous timelocks is refused outright", () => {
  const i = crossChain();
  i.terms = { ...i.terms, makerRefundAt: BTC_TIP + 6, takerRefundAt: BASE_TIP + 20000 };
  assert.equal(readCross(i).reason, "unsafe_timelocks");
});

test("a same-chain intent is pushed to the atomic method, not HTLC", () => {
  const i = crossChain();
  i.give = { chain: CHAINS.base, asset: "0x1", amount: "1" };
  i.want = { chain: CHAINS.base, asset: "0x2", amount: "1" };
  assert.equal(readCross(i).reason, "same_chain_use_atomic_method");
});
