// check() is the gate that decides whether a taker spends gas. These tests drive it
// against a fake chain so every refusal reason is exercised, plus real reads on Base.
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildOrder, signOrder, orderHash } from "../src/offer.mjs";
import { check, toAdvanced, connect, seaport } from "../src/fill.mjs";
import { CHAIN_ID, SEAPORT, TOKENS, DEFAULT_RPCS } from "../src/constants.mjs";

const alice = new ethers.Wallet("0x" + "11".repeat(32));
const NOW = 1_800_000_000;
const BOB = "0x2222222222222222222222222222222222222222";

const signedOffer = (over = {}) => signOrder(alice, buildOrder({
  offerer: alice.address,
  give: { token: "USDC", amount: "1.0" },
  want: { token: "EURC", amount: "0.92" },
  startTime: NOW, salt: "0x" + "cd".repeat(32), ...over,
}));

// A provider that answers exactly what the chain would, so we can make each
// precondition fail on purpose. Anything unexpected throws rather than defaults:
// a fake that silently returns zero would make these tests prove nothing.
function fakeChain({ makerBalance = 10n ** 6n, makerAllowance = 10n ** 6n, takerBalance = 10n ** 6n,
                     takerAllowance = 10n ** 6n, cancelled = false, filled = 0n, counter = 0n, hash } = {}) {
  return {
    async getBlock() { return { timestamp: NOW + 10 }; },
    async call(tx) {
      const sel = tx.data.slice(0, 10);
      const addr = ethers.getAddress(tx.to);
      const w = (v) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
      if (addr === ethers.getAddress(SEAPORT)) {
        if (sel === "0x79df72bd") return hash;                                  // getOrderHash
        if (sel === "0x46423aa7") return ethers.concat([w(1n), w(cancelled ? 1n : 0n), w(filled), w(filled)]); // getOrderStatus
        if (sel === "0xf07ec373") return w(counter);                            // getCounter
        throw new Error("unexpected seaport selector " + sel);
      }
      const isGive = addr === ethers.getAddress(TOKENS.USDC.address);
      if (sel === "0x70a08231") return w(isGive ? makerBalance : takerBalance);  // balanceOf
      if (sel === "0xdd62ed3e") return w(isGive ? makerAllowance : takerAllowance); // allowance
      throw new Error("unexpected token selector " + sel);
    },
  };
}

test("a good offer passes every gate", async () => {
  const signed = await signedOffer();
  const r = await check(signed, { provider: await fakeChain({ hash: orderHash(signed.parameters) }), taker: BOB });
  assert.deepEqual(r.problems, []);
  assert.ok(r.fillable);
});

test("expiry is checked before any RPC call is made", async () => {
  const signed = await signedOffer({ expirySeconds: 5 });
  // No provider passed at all: if check() touched the network this would throw.
  const r = await check(signed, { provider: null, now: NOW + 6 });
  assert.equal(r.fillable, false);
  assert.deepEqual(r.problems, ["offer has expired"]);
});

test("an offer that is not active yet is refused without RPC", async () => {
  const signed = await signedOffer({ startTime: NOW + 1000 });
  const r = await check(signed, { provider: null, now: NOW });
  assert.deepEqual(r.problems, ["offer is not active yet"]);
});

test("each maker-side failure is named in plain words", async () => {
  const signed = await signedOffer();
  const hash = orderHash(signed.parameters);
  const cases = [
    [{ makerBalance: 0n }, "maker no longer has the tokens"],
    [{ makerAllowance: 0n }, "maker withdrew their approval"],
    [{ cancelled: true }, "maker cancelled this offer"],
    [{ filled: 1n }, "offer was already taken"],
    [{ counter: 7n }, "maker cancelled all their offers"],
  ];
  for (const [state, reason] of cases) {
    const r = await check(signed, { provider: await fakeChain({ hash, ...state }), taker: BOB });
    assert.equal(r.fillable, false, reason);
    assert.ok(r.problems.includes(reason), `expected "${reason}", got ${JSON.stringify(r.problems)}`);
  }
});

test("the taker is told when the problem is on their own side", async () => {
  const signed = await signedOffer();
  const hash = orderHash(signed.parameters);
  for (const [state, reason] of [
    [{ takerBalance: 0n }, "you do not have enough to pay for this"],
    [{ takerAllowance: 0n }, "you have not approved Seaport yet"],
  ]) {
    const r = await check(signed, { provider: await fakeChain({ hash, ...state }), taker: BOB });
    assert.ok(r.problems.includes(reason));
  }
});

test("a hash that disagrees with Seaport stops the fill", async () => {
  const signed = await signedOffer();
  const r = await check(signed, { provider: await fakeChain({ hash: "0x" + "ff".repeat(32) }), taker: BOB });
  assert.ok(r.problems.includes("order hash disagrees with Seaport"));
});

test("fulfillOrder gets totalOriginalConsiderationItems, not counter", async () => {
  const signed = await signedOffer();
  const adv = toAdvanced(signed);
  assert.equal(adv.parameters.totalOriginalConsiderationItems, 1);
  assert.equal("counter" in adv.parameters, false);
  assert.equal(adv.signature, signed.signature);
});

// --- against the real chain, read only ------------------------------------
const p = await (async () => { try { return await connect(DEFAULT_RPCS); } catch { return null; } })();
const online = { skip: p ? false : "no Base RPC reachable" };

test("an unpublished order reads as untouched on Base", online, async () => {
  const signed = await signedOffer();
  const status = await seaport(p).getOrderStatus(orderHash(signed.parameters));
  assert.equal(status.isValidated, false);
  assert.equal(status.isCancelled, false);
  assert.equal(status.totalFilled, 0n);
});

test("a fresh maker starts at counter zero", online, async () => {
  assert.equal(await seaport(p).getCounter(alice.address), 0n);
});

test("check() against the real chain refuses: the maker has nothing", online, async () => {
  // Backdated: the latest block's timestamp trails wall clock by a few seconds,
  // and a not-yet-active offer would short-circuit before the balance reads.
  const signed = await signedOffer({ startTime: Math.floor(Date.now() / 1000) - 600 });
  const r = await check(signed, { provider: p, taker: BOB });
  assert.equal(r.fillable, false);
  assert.ok(r.problems.includes("maker no longer has the tokens"));
  assert.ok(r.problems.includes("maker withdrew their approval"));
});
