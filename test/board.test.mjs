import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildOrder, signOrder, orderHash } from "../src/offer.mjs";
import { toNote, fromNote, toFile, fromFile, SCHEMA_VERSION } from "../src/board.mjs";
import { OFFER_KIND, CHAIN_ID, SEAPORT } from "../src/constants.mjs";

const alice = new ethers.Wallet("0x" + "11".repeat(32));
const mallory = new ethers.Wallet("0x" + "22".repeat(32));
const NOW = 1_800_000_000;

async function anOffer(over = {}) {
  return signOrder(alice, buildOrder({
    offerer: alice.address,
    give: { token: "USDC", amount: "1.0" },
    want: { token: "EURC", amount: "0.92" },
    startTime: NOW, salt: "0x" + "ab".repeat(32), ...over,
  }));
}
const read = (note) => fromNote(note, { now: NOW + 1 });

test("a note carries the whole order, so a reader needs nothing else", async () => {
  const signed = await anOffer();
  const note = toNote(signed);
  assert.equal(note.kind, OFFER_KIND);
  const body = JSON.parse(note.content);
  assert.equal(body.v, SCHEMA_VERSION);
  assert.equal(body.chainId, CHAIN_ID);
  assert.equal(body.seaport, SEAPORT);
  assert.deepEqual(body.order, signed.parameters);
  assert.equal(body.signature, signed.signature);
});

test("tags let a reader filter without parsing the body", async () => {
  const t = Object.fromEntries(toNote(await anOffer()).tags.map(([k, ...v]) => [k, v]));
  assert.equal(t.d[0], orderHash((await anOffer()).parameters));
  assert.equal(t.expiration[0], String(NOW + 3600));
  assert.equal(t.chain[0], String(CHAIN_ID));
  assert.equal(t.gives[1], "1000000");
  assert.equal(t.wants[1], "920000");
});

test("round trip through a note keeps the order fillable", async () => {
  const signed = await anOffer();
  const r = read(toNote(signed));
  assert.ok(r.ok, r.reason);
  assert.deepEqual(r.signed.parameters, signed.parameters);
  assert.equal(r.hash, orderHash(signed.parameters));
});

test("round trip through a file works with no relay at all", async () => {
  const signed = await anOffer();
  const r = fromFile(toFile(signed), { now: NOW + 1 });
  assert.ok(r.ok, r.reason);
  assert.equal(r.signed.signature, signed.signature);
});

test("hostile input is skipped, never thrown", async () => {
  const cases = [
    [null, "wrong_kind"],
    [{ kind: 1, content: "{}" }, "wrong_kind"],
    [{ kind: OFFER_KIND, content: "not json" }, "unparseable"],
    [{ kind: OFFER_KIND, content: JSON.stringify({ v: "other" }) }, "unknown_version"],
  ];
  for (const [note, reason] of cases) assert.equal(read(note).reason, reason);
  assert.equal(fromFile("<html>", { now: NOW }).reason, "unparseable");
});

test("an offer for another chain is refused", async () => {
  const note = toNote(await anOffer(), { chainId: 1 });
  assert.equal(read(note).reason, "wrong_chain");
});

test("an offer pointing at a different settlement contract is refused", async () => {
  const note = toNote(await anOffer());
  const body = JSON.parse(note.content);
  body.seaport = "0x000000000000000000000000000000000000dEaD";
  assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, "unknown_settlement_contract");
});

test("an expired offer is refused", async () => {
  const note = toNote(await anOffer({ expirySeconds: 60 }));
  assert.equal(fromNote(note, { now: NOW + 61 }).reason, "expired");
});

test("a forged signature is refused", async () => {
  const signed = await anOffer();
  const note = toNote(signed);
  const body = JSON.parse(note.content);
  body.signature = await mallory.signTypedData(
    { name: "Seaport", version: "1.6", chainId: CHAIN_ID, verifyingContract: SEAPORT },
    (await import("../src/offer.mjs")).EIP712_TYPES, signed.parameters);
  assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, "bad_signature");
});

test("editing the price after signing is refused", async () => {
  const signed = await anOffer();
  const note = toNote(signed);
  const body = JSON.parse(note.content);
  body.order.consideration[0].startAmount = "1";
  assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, "bad_signature");
});

test("an order with a zone or a conduit is refused: it could hook the fill", async () => {
  const signed = await anOffer();
  for (const [field, value, reason] of [
    ["zone", "0x000000000000000000000000000000000000dEaD", "has_zone"],
    ["conduitKey", "0x" + "11".repeat(32), "has_conduit"],
  ]) {
    const note = toNote(signed);
    const body = JSON.parse(note.content);
    body.order[field] = value;
    assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, reason);
  }
});

test("multi-item orders are refused in v1", async () => {
  const signed = await anOffer();
  const note = toNote(signed);
  const body = JSON.parse(note.content);
  body.order.offer = [body.order.offer[0], body.order.offer[0]];
  assert.equal(read({ ...note, content: JSON.stringify(body) }).reason, "unsupported_shape");
});
