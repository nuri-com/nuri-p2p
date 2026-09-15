// The Bitcoin half, tested without spending anything. Every case here is one way
// a peer could lose coins if the code were wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  htlcScript, htlcAddress, readScript, verifyAddress, newSecret, pubkey,
  claimTx, refundTx, preimageFromWitness, asBytes, hex, NETWORKS, tipHeight, utxos,
} from "../src/btc.mjs";

const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";
const MAINNET = "bip122:000000000019d6689c085ae165831e93";
const CLAIM_KEY = "11".repeat(32);
const REFUND_KEY = "22".repeat(32);
const secret = newSecret();

const terms = (over = {}) => ({
  hash: secret.hash,
  claimPubkey: pubkey(CLAIM_KEY),
  refundPubkey: pubkey(REFUND_KEY),
  timeoutBlock: 900000,
  ...over,
});

const utxo = (value = 20000n) => [{ txid: "aa".repeat(32), vout: 0, value }];

test("a secret is 32 bytes and its hash is the sha256 of it", () => {
  const s = newSecret();
  assert.equal(asBytes(s.preimage).length, 32);
  assert.equal(s.hash, hex(sha256(asBytes(s.preimage))));
  assert.notEqual(s.preimage, newSecret().preimage, "two secrets must not be equal");
});

test("the script is the shape both chains agree on", () => {
  const ops = btc.Script.decode(htlcScript(terms())).map((o) => (typeof o === "string" ? o : "DATA"));
  assert.deepEqual(ops, [
    "SHA256", "DATA", "EQUAL",
    "IF", "DATA",
    "ELSE", "DATA", "CHECKLOCKTIMEVERIFY", "DROP", "DATA",
    "ENDIF", "CHECKSIG",
  ]);
});

test("the terms can be read back out of the script", () => {
  const t = terms();
  const back = readScript(htlcScript(t));
  assert.equal(back.hash, t.hash);
  assert.equal(back.claimPubkey, t.claimPubkey);
  assert.equal(back.refundPubkey, t.refundPubkey);
  assert.equal(back.timeoutBlock, t.timeoutBlock);
});

test("a malformed script is refused, not guessed at", () => {
  const notHtlc = btc.Script.encode(["DUP", "HASH160", new Uint8Array(20), "EQUALVERIFY", "CHECKSIG"]);
  assert.throws(() => readScript(notHtlc), /not an HTLC script/);
});

test("the same terms always produce the same address", () => {
  assert.equal(htlcAddress(terms(), SIGNET).address, htlcAddress(terms(), SIGNET).address);
});

test("changing any term changes the address", () => {
  const base = htlcAddress(terms(), SIGNET).address;
  const changes = [
    { hash: newSecret().hash },
    { timeoutBlock: 900001 },
    { claimPubkey: pubkey("33".repeat(32)) },
    { refundPubkey: pubkey("44".repeat(32)) },
  ];
  for (const over of changes) {
    assert.notEqual(htlcAddress(terms(over), SIGNET).address, base, `${Object.keys(over)[0]} did not change the address`);
  }
});

test("signet and mainnet addresses are never confused", () => {
  const s = htlcAddress(terms(), SIGNET);
  const m = htlcAddress(terms(), MAINNET);
  assert.match(s.address, /^tb1/);
  assert.match(m.address, /^bc1/);
  assert.notEqual(s.address, m.address);
  // The script is chain-independent; only the address encoding differs.
  assert.equal(s.script, m.script);
});

test("verifyAddress accepts the real terms and rejects tampered ones", () => {
  const t = terms();
  const { address } = htlcAddress(t, SIGNET);
  assert.equal(verifyAddress(address, t, SIGNET), true);
  assert.equal(verifyAddress(address, { ...t, timeoutBlock: t.timeoutBlock + 1 }, SIGNET), false);
  assert.equal(verifyAddress(address, { ...t, hash: newSecret().hash }, SIGNET), false);
  // Same terms, wrong chain: a mainnet address must never verify as signet.
  assert.equal(verifyAddress(htlcAddress(t, MAINNET).address, t, SIGNET), false);
});

test("a timestamp timelock is refused — it would open at the wrong time", () => {
  assert.throws(() => htlcScript(terms({ timeoutBlock: 1789000000 })), /block height, not a timestamp/);
  assert.throws(() => htlcScript(terms({ timeoutBlock: 0 })), /positive block height/);
  assert.throws(() => htlcScript(terms({ timeoutBlock: -1 })), /positive block height/);
});

test("a wrong-sized hash or key is refused", () => {
  assert.throws(() => htlcScript(terms({ hash: "aa".repeat(31) })), /32 bytes/);
  assert.throws(() => htlcScript(terms({ claimPubkey: "02".repeat(20) })), /claimPubkey/);
  // Uncompressed keys are 65 bytes and would change the address silently.
  assert.throws(() => htlcScript(terms({ refundPubkey: "04".repeat(65) })), /refundPubkey/);
});

test("an unknown chain is refused rather than defaulted", () => {
  assert.throws(() => htlcAddress(terms(), "eip155:8453"), /unknown bitcoin chain/);
  assert.throws(() => htlcAddress(terms(), "bip122:deadbeef"), /unknown bitcoin chain/);
});

test("a claim spends with <sig> <preimage> <script> and no locktime", () => {
  const { script } = htlcAddress(terms(), SIGNET);
  const tx = claimTx({ chain: SIGNET, script, utxos: utxo(), to: htlcAddress(terms(), SIGNET).address, feeSats: 400, preimage: secret.preimage, privateKey: CLAIM_KEY });
  assert.equal(tx.lockTime, 0, "a claim must not wait for a block");
  const w = tx.getInput(0).finalScriptWitness;
  assert.equal(w.length, 3);
  assert.equal(hex(w[1]), secret.preimage, "the preimage must be on the stack");
  assert.equal(hex(w[2]), script);
});

test("a refund spends with an empty element and the script's own timeout", () => {
  const t = terms();
  const { script, address } = htlcAddress(t, SIGNET);
  const tx = refundTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, privateKey: REFUND_KEY });
  assert.equal(tx.lockTime, t.timeoutBlock, "the locktime must match the script or the spend is invalid");
  const w = tx.getInput(0).finalScriptWitness;
  assert.equal(w.length, 3);
  assert.equal(w[1].length, 0, "the ELSE branch needs an empty element");
  // A refund must never leak a secret it does not have.
  assert.equal(preimageFromWitness(hex(tx.extract())), null);
});

test("every input carries a non-final sequence, or CLTV rejects the spend", () => {
  const { script, address } = htlcAddress(terms(), SIGNET);
  for (const tx of [
    claimTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, preimage: secret.preimage, privateKey: CLAIM_KEY }),
    refundTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, privateKey: REFUND_KEY }),
  ]) {
    assert.notEqual(tx.getInput(0).sequence, 0xffffffff);
  }
});

test("a claim reveals the secret, which is what unlocks the other chain", () => {
  const { script, address } = htlcAddress(terms(), SIGNET);
  const tx = claimTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, preimage: secret.preimage, privateKey: CLAIM_KEY });
  assert.equal(preimageFromWitness(hex(tx.extract())), secret.preimage);
});

test("the wrong secret cannot build a claim", () => {
  const { script, address } = htlcAddress(terms(), SIGNET);
  assert.throws(
    () => claimTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, preimage: newSecret().preimage, privateKey: CLAIM_KEY }),
    /preimage does not match/,
  );
});

test("the wrong key cannot build a claim or a refund", () => {
  const { script, address } = htlcAddress(terms(), SIGNET);
  assert.throws(
    () => claimTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, preimage: secret.preimage, privateKey: REFUND_KEY }),
    /not the claim key/,
  );
  assert.throws(
    () => refundTx({ chain: SIGNET, script, utxos: utxo(), to: address, feeSats: 400, privateKey: CLAIM_KEY }),
    /not the refund key/,
  );
});

test("a fee that would eat the whole output is refused", () => {
  const { script, address } = htlcAddress(terms(), SIGNET);
  const build = (feeSats, value = 20000n) =>
    claimTx({ chain: SIGNET, script, utxos: utxo(value), to: address, feeSats, preimage: secret.preimage, privateKey: CLAIM_KEY });
  assert.throws(() => build(20000), /nothing left after fee/);
  assert.throws(() => build(25000), /nothing left after fee/);
  assert.throws(() => build(0), /feeSats must be positive/);
  assert.throws(() => build(-100), /feeSats must be positive/);
});

test("the output is the input minus exactly the fee", () => {
  const { script, address } = htlcAddress(terms(), SIGNET);
  const tx = claimTx({ chain: SIGNET, script, utxos: utxo(20000n), to: address, feeSats: 400, preimage: secret.preimage, privateKey: CLAIM_KEY });
  assert.equal(tx.getOutput(0).amount, 19600n);
});

// --- live reads, no spending ------------------------------------------------

test("signet is reachable and its tip is a plausible height", async () => {
  const tip = await tipHeight(SIGNET);
  assert.equal(typeof tip, "number");
  assert.ok(tip > 300000, `signet tip looks wrong: ${tip}`);
});

test("a fresh htlc address is empty on the real chain", async () => {
  const { address } = htlcAddress(terms({ hash: newSecret().hash }), SIGNET);
  assert.deepEqual(await utxos(SIGNET, address), []);
});
