// Proof that the Bitcoin half works, on signet, with coins that cost nothing but
// behave exactly like mainnet coins.
//
//   1. lock sats in an HTLC address
//   2. claim them with the secret          (the happy path)
//   3. lock again, let the timeout pass, refund  (the unhappy path)
//
// Both paths are what protects a peer: one releases the funds, the other gets
// them back when the counterparty walks away. A swap that only proves the first
// one is a swap that has never been tested.
//
// Usage:
//   node scripts/prove-btc.mjs              # dry run, builds and checks, broadcasts nothing
//   SIGNET_KEY=<hex> node scripts/prove-btc.mjs --execute

import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  htlcAddress, readScript, verifyAddress, newSecret, pubkey, asBytes, hex,
  tipHeight, utxos, broadcast, txStatus, claimTx, refundTx, preimageFromWitness,
} from "../src/btc.mjs";

const SIGNET = "bip122:00000008819873e925422c1ff0f99f7c";
const NET = btc.TEST_NETWORK;
const execute = process.argv.includes("--execute");
const FEE = 400n; // sats; signet blocks are empty, this clears immediately

const say = (...a) => console.log(...a);
const fail = (m) => { console.error("\nFAILED:", m); process.exit(1); };

// --- keys -------------------------------------------------------------------
const walletKey = process.env.SIGNET_KEY;
if (execute && !walletKey) fail("SIGNET_KEY is required with --execute");
const key = walletKey ?? "99".repeat(32);
const walletPub = secp256k1.getPublicKey(asBytes(key), true);
const walletAddr = btc.p2wpkh(walletPub, NET).address;
const walletScript = btc.p2wpkh(walletPub, NET).script;

// The two roles. In a real swap these are two different people; here one wallet
// plays both so the test needs no second party.
const claimKey = "11".repeat(32);
const refundKey = "22".repeat(32);

say("wallet:", walletAddr);
const tip = await tipHeight(SIGNET);
say("signet tip:", tip);

// --- the lock ---------------------------------------------------------------
const secret = newSecret();
const terms = {
  hash: secret.hash,
  claimPubkey: pubkey(claimKey),
  refundPubkey: pubkey(refundKey),
  timeoutBlock: tip + 3, // short: this test waits for it
};
const lock = htlcAddress(terms, SIGNET);
say("\nhtlc address:", lock.address);
say("timeout block:", terms.timeoutBlock, `(${terms.timeoutBlock - tip} blocks away)`);

// A peer about to fund this must be able to check it themselves.
if (!verifyAddress(lock.address, terms, SIGNET)) fail("address does not encode the agreed terms");
const back = readScript(lock.script);
if (back.hash !== terms.hash || back.timeoutBlock !== terms.timeoutBlock) fail("script does not read back");
if (verifyAddress(lock.address, { ...terms, timeoutBlock: terms.timeoutBlock + 1 }, SIGNET)) {
  fail("a different timeout produced the same address — the check is worthless");
}
say("address verifies against the terms, and a tampered timeout does not");

if (!execute) {
  say("\nNothing was broadcast. To prove it for real:");
  say("  SIGNET_KEY=<hex> node scripts/prove-btc.mjs --execute");
  process.exit(0);
}

// --- funding ----------------------------------------------------------------
// Only confirmed coins. Spending an unconfirmed output inherits its whole
// ancestor chain, and a faucet payout sits at the end of a long one — signet
// rejected our first attempt with "too many unconfirmed ancestors [limit: 25]".
// A swap built on somebody else's unconfirmed chain is a swap that can vanish.
const all = await utxos(SIGNET, walletAddr);
const spendable = all.filter((u) => u.confirmed);
const have = spendable.reduce((s, u) => s + u.value, 0n);
const pending = all.filter((u) => !u.confirmed).reduce((s, u) => s + u.value, 0n);
say("\nwallet has", have, "confirmed sats in", spendable.length, "utxo(s)");
if (pending > 0n) say("(plus", pending, "sats still unconfirmed — not used)");
if (spendable.length === 0) fail(`no confirmed coins yet${pending > 0n ? `; ${pending} sats are waiting for a block` : ""}`);
const LOCK_AMOUNT = 20000n;
if (have < LOCK_AMOUNT * 2n + FEE * 4n) fail(`not enough signet coins: have ${have}, need ~${LOCK_AMOUNT * 2n + FEE * 4n}`);

const fundHtlc = (from, amount, to) => {
  const total = from.reduce((s, u) => s + u.value, 0n);
  const tx = new btc.Transaction({ allowUnknownOutputs: false });
  for (const u of from) {
    tx.addInput({ txid: asBytes(u.txid), index: u.vout, witnessUtxo: { script: walletScript, amount: u.value } });
  }
  tx.addOutputAddress(to, amount, NET);
  const change = total - amount - FEE;
  if (change > 546n) tx.addOutputAddress(walletAddr, change, NET);
  tx.sign(asBytes(key));
  tx.finalize();
  return tx;
};

const waitFor = async (txid, what) => {
  for (let i = 0; i < 60; i++) {
    const s = await txStatus(SIGNET, txid).catch(() => null);
    if (s?.confirmed) return s.block_height;
    await new Promise((r) => setTimeout(r, 10000));
  }
  fail(`${what} never confirmed: ${txid}`);
};

say("\n--- happy path: lock, then claim with the secret ---");
const fund1 = fundHtlc(spendable, LOCK_AMOUNT, lock.address);
const fund1Id = await broadcast(SIGNET, hex(fund1.extract()));
say("funded:", fund1Id);
const fund1Height = await waitFor(fund1Id, "funding");
say("confirmed in block", fund1Height);

const locked = await utxos(SIGNET, lock.address);
if (locked.length !== 1 || locked[0].value !== LOCK_AMOUNT) fail(`expected ${LOCK_AMOUNT} sats locked, saw ${JSON.stringify(locked.map(String))}`);
say("the htlc holds", locked[0].value, "sats");

// The wrong secret must not be spendable. Build it and let the network judge.
const wrongSecret = newSecret();
let refusedWrong = false;
try {
  const bad = claimTx({ chain: SIGNET, script: lock.script, utxos: locked, to: walletAddr, feeSats: FEE, preimage: wrongSecret.preimage, privateKey: claimKey });
  await broadcast(SIGNET, hex(bad.extract()));
} catch { refusedWrong = true; }
if (!refusedWrong) fail("a claim with the wrong secret was accepted — the lock does not lock");
say("a claim with the wrong secret is rejected");

const claim = claimTx({ chain: SIGNET, script: lock.script, utxos: locked, to: walletAddr, feeSats: FEE, preimage: secret.preimage, privateKey: claimKey });
const claimHex = hex(claim.extract());
const claimId = await broadcast(SIGNET, claimHex);
say("claimed:", claimId);
const claimHeight = await waitFor(claimId, "claim");
say("confirmed in block", claimHeight);

// This is the part that makes a cross-chain swap work: the secret is now public.
const revealed = preimageFromWitness(claimHex);
if (revealed !== secret.preimage) fail("the claim did not reveal the secret");
say("the secret is now readable on chain:", revealed);

// --- unhappy path -----------------------------------------------------------
say("\n--- unhappy path: lock, wait out the timeout, refund ---");
const tip2 = await tipHeight(SIGNET);
const terms2 = { ...terms, hash: newSecret().hash, timeoutBlock: tip2 + 2 };
const lock2 = htlcAddress(terms2, SIGNET);
say("htlc address:", lock2.address, "timeout at", terms2.timeoutBlock);

const fund2 = fundHtlc((await utxos(SIGNET, walletAddr)).filter((u) => u.confirmed), LOCK_AMOUNT, lock2.address);
const fund2Id = await broadcast(SIGNET, hex(fund2.extract()));
say("funded:", fund2Id);
await waitFor(fund2Id, "second funding");
const locked2 = await utxos(SIGNET, lock2.address);
say("the htlc holds", locked2[0].value, "sats");

// Early refund must fail. The whole point of the timeout is that it holds.
let refusedEarly = false;
try {
  const early = refundTx({ chain: SIGNET, script: lock2.script, utxos: locked2, to: walletAddr, feeSats: FEE, privateKey: refundKey });
  await broadcast(SIGNET, hex(early.extract()));
} catch { refusedEarly = true; }
if (!refusedEarly) fail("a refund before the timeout was accepted — the timeout means nothing");
say("a refund before the timeout is rejected");

say("waiting for block", terms2.timeoutBlock, "...");
for (let i = 0; i < 90; i++) {
  if (await tipHeight(SIGNET) >= terms2.timeoutBlock) break;
  await new Promise((r) => setTimeout(r, 10000));
}
const nowTip = await tipHeight(SIGNET);
if (nowTip < terms2.timeoutBlock) fail(`signet did not reach block ${terms2.timeoutBlock} in time (tip ${nowTip})`);
say("tip is", nowTip);

const refund = refundTx({ chain: SIGNET, script: lock2.script, utxos: locked2, to: walletAddr, feeSats: FEE, privateKey: refundKey });
const refundId = await broadcast(SIGNET, hex(refund.extract()));
say("refunded:", refundId);
await waitFor(refundId, "refund");
if ((await utxos(SIGNET, lock2.address)).length !== 0) fail("the htlc still holds coins after the refund");
say("the htlc is empty again");

say("\nPROVEN on signet:");
say("  the secret releases the coins, a wrong secret does not");
say("  the timeout holds, and after it the funder gets the coins back");
say("  the claim publishes the secret, which is what unlocks the other chain");
say("\n  funding    ", fund1Id);
say("  claim      ", claimId);
say("  funding 2  ", fund2Id);
say("  refund     ", refundId);
