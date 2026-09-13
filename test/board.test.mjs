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

test("cross-chain intents are readable by a client that cannot execute them", () => {
  const i = {
    v: SCHEMA_VERSION, settle: "htlc-v1", by: alice.address, id: "0x" + "aa".repeat(32),
    give: { chain: CHAINS.bitcoin, asset: "btc", amount: "100000" },
    want: { chain: CHAINS.base, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "100000000" },
    expiry: NOW + 86400,
    terms: { hash: "a".repeat(64), makerRefundAt: NOW + 86400, takerRefundAt: NOW + 43200 },
    proof: "0x00",
  };
  const r = read({ kind: OFFER_KIND, content: JSON.stringify(i) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_adapter_yet");
  assert.equal(r.readable, true, "readable, but honestly not executable yet");
});

test("timelock ordering is enforced: the taker must be able to refund first", () => {
  assert.ok(timelocksAreSafe({ makerRefundAt: 100000, takerRefundAt: 50000 }));
  assert.equal(timelocksAreSafe({ makerRefundAt: 50000, takerRefundAt: 100000 }), false);
  // Equal deadlines are a race, not a swap.
  assert.equal(timelocksAreSafe({ makerRefundAt: 50000, takerRefundAt: 50000 }), false);
  // Too small a gap loses money on a congested chain.
  assert.equal(timelocksAreSafe({ makerRefundAt: 51000, takerRefundAt: 50000 }), false);
});

test("an HTLC intent with dangerous timelocks is refused outright", () => {
  const i = {
    v: SCHEMA_VERSION, settle: "htlc-v1", by: alice.address, id: "0x" + "aa".repeat(32),
    give: { chain: CHAINS.bitcoin, asset: "btc", amount: "1" },
    want: { chain: CHAINS.base, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1" },
    expiry: NOW + 86400,
    terms: { hash: "a".repeat(64), makerRefundAt: NOW + 3600, takerRefundAt: NOW + 86400 },
    proof: "0x00",
  };
  assert.equal(read({ kind: OFFER_KIND, content: JSON.stringify(i) }).reason, "unsafe_timelocks");
});

test("a same-chain intent is pushed to the atomic method, not HTLC", () => {
  const i = {
    v: SCHEMA_VERSION, settle: "htlc-v1", by: alice.address, id: "0x" + "aa".repeat(32),
    give: { chain: CHAINS.base, asset: "0x1", amount: "1" },
    want: { chain: CHAINS.base, asset: "0x2", amount: "1" },
    expiry: NOW + 86400,
    terms: { hash: "a".repeat(64), makerRefundAt: NOW + 86400, takerRefundAt: NOW + 43200 },
    proof: "0x00",
  };
  assert.equal(read({ kind: OFFER_KIND, content: JSON.stringify(i) }).reason, "same_chain_use_atomic_method");
});
