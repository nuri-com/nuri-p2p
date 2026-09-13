import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  buildOrder, orderHash, signOrder, signatureMatchesOfferer, recoverSigner,
  domain, EIP712_TYPES, ZERO_ADDRESS, ZERO_BYTES32, toUnits,
} from "../src/offer.mjs";
import { CHAIN_ID, SEAPORT, TOKENS, ORDER_TYPE, ITEM_TYPE } from "../src/constants.mjs";

const alice = new ethers.Wallet("0x" + "11".repeat(32));
const mallory = new ethers.Wallet("0x" + "22".repeat(32));
const FIXED = { startTime: 1_800_000_000, salt: "0x" + "ab".repeat(32) };

function anOrder(over = {}) {
  return buildOrder({
    offerer: alice.address,
    give: { token: "USDC", amount: "1.0" },
    want: { token: "EURC", amount: "0.92" },
    ...FIXED, ...over,
  });
}

test("amounts use the token's decimals, not floats", () => {
  assert.equal(toUnits("1.0", "USDC"), "1000000");
  assert.equal(toUnits("0.000001", "EURC"), "1");
});

test("order pays the maker directly, so a filler cannot redirect it", () => {
  const o = anOrder();
  assert.equal(o.consideration[0].recipient, alice.address);
  assert.equal(o.offer[0].token, TOKENS.USDC.address);
  assert.equal(o.consideration[0].token, TOKENS.EURC.address);
  assert.equal(o.offer[0].itemType, ITEM_TYPE.ERC20);
});

test("order is FULL_OPEN: anybody may fill it, all or nothing", () => {
  assert.equal(anOrder().orderType, ORDER_TYPE.FULL_OPEN);
});

test("no zone, no conduit: nothing can hook or intercept the fill", () => {
  const o = anOrder();
  assert.equal(o.zone, ZERO_ADDRESS);
  assert.equal(o.zoneHash, ZERO_BYTES32);
  assert.equal(o.conduitKey, ZERO_BYTES32);
});

test("an offer always expires", () => {
  const o = anOrder({ expirySeconds: 600 });
  assert.equal(Number(o.endTime) - Number(o.startTime), 600);
});

test("a fresh offer is already active against the real chain clock", async () => {
  // Regression: startTime defaulted to exactly wall-clock now, but block timestamps
  // trail by a second or two — every fill at a second boundary was refused as
  // "not active yet". The default must already be in the past.
  const { connect } = await import("../src/fill.mjs");
  let p;
  try { p = await connect(); } catch { return; } // offline: nothing to assert against
  const now = Math.floor(Date.now() / 1000);
  const o = buildOrder({ offerer: alice.address, give: { token: "USDC", amount: "1" }, want: { token: "EURC", amount: "1" } });
  const ts = (await p.getBlock("latest")).timestamp;
  assert.ok(Number(o.startTime) <= ts, `startTime ${o.startTime} is after block time ${ts} (wall ${now})`);
});

test("rejects nonsense before it can ever be signed", () => {
  assert.throws(() => anOrder({ expirySeconds: 0 }), /positive/);
  assert.throws(() => buildOrder({ offerer: "not-an-address", give: { token: "USDC", amount: "1" }, want: { token: "EURC", amount: "1" } }), /address/);
  assert.throws(() => buildOrder({ offerer: alice.address, give: { token: "DOGE", amount: "1" }, want: { token: "EURC", amount: "1" } }), /unknown token/);
  assert.throws(() => anOrder({ give: { token: "USDC", amount: "0" } }), /greater than zero/);
});

test("two offers from the same maker are distinct", () => {
  const a = buildOrder({ offerer: alice.address, give: { token: "USDC", amount: "1" }, want: { token: "EURC", amount: "1" } });
  const b = buildOrder({ offerer: alice.address, give: { token: "USDC", amount: "1" }, want: { token: "EURC", amount: "1" } });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(orderHash(a), orderHash(b));
});

test("signature verifies back to the maker", async () => {
  const signed = await signOrder(alice, anOrder());
  assert.equal(recoverSigner(signed), alice.address);
  assert.ok(signatureMatchesOfferer(signed));
});

test("someone else's signature on my order is refused", async () => {
  const order = anOrder();
  const forged = { parameters: order, signature: await mallory.signTypedData(domain(), EIP712_TYPES, order) };
  assert.equal(signatureMatchesOfferer(forged), false);
});

test("changing one number after signing breaks the signature", async () => {
  const signed = await signOrder(alice, anOrder());
  const tampered = {
    parameters: { ...signed.parameters, consideration: [{ ...signed.parameters.consideration[0], startAmount: "1", endAmount: "1" }] },
    signature: signed.signature,
  };
  assert.equal(signatureMatchesOfferer(tampered), false);
});

test("garbage signature is refused, not thrown", () => {
  assert.equal(signatureMatchesOfferer({ parameters: anOrder(), signature: "0xdead" }), false);
});

test("a signature for another chain does not work here", async () => {
  const order = anOrder();
  const elsewhere = { parameters: order, signature: await alice.signTypedData(domain(1), EIP712_TYPES, order) };
  assert.equal(signatureMatchesOfferer(elsewhere, CHAIN_ID, SEAPORT), false);
});
