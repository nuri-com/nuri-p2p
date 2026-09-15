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

import { mkdirSync, writeFileSync } from "node:fs";
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
  // Far enough ahead that funding cannot confirm past it. Signet blocks arrive
  // 10-40 minutes apart, and a previous run had the chain overtake a 3-block
  // timeout while waiting — which silently turned the "refund is too early"
  // check into a refund that was simply on time. A test whose premise can expire
  // is a test that proves nothing.
  timeoutBlock: tip + 8,
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

// Write down what is needed to get the coins back, BEFORE the coins move.
// Learned the hard way: a run died between funding and claiming, and the secret
// lived only in memory. The address is derived from the secret's hash, so
// without it the script cannot even be rebuilt — the coins are unreachable by
// either path, forever. On signet that cost nothing. On mainnet it is a loss.
const remember = (note) => {
  const dir = new URL("../proofs/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`htlc-${note.address.slice(-12)}.json`, dir);
  writeFileSync(file, JSON.stringify(note, null, 2));
  say("wrote recovery note:", file.pathname.split("/").slice(-2).join("/"));
};

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

// Signet's block production is irregular — it is a test network mined by a
// signer, not by a race. We measured 20+ minute gaps. Waiting "ten minutes"
// turns a healthy chain into a failed proof, so the patience here is generous
// and says out loud what it is waiting for.
const PATIENCE_MS = 90 * 60 * 1000;

const waitFor = async (txid, what) => {
  const until = Date.now() + PATIENCE_MS;
  let said = 0;
  while (Date.now() < until) {
    const s = await txStatus(SIGNET, txid).catch(() => null);
    if (s?.confirmed) return s.block_height;
    const mins = Math.round((Date.now() - (until - PATIENCE_MS)) / 60000);
    if (mins >= said + 5) { say(`  still waiting for ${what} (${mins} min, tip ${await tipHeight(SIGNET).catch(() => "?")})`); said = mins; }
    await new Promise((r) => setTimeout(r, 15000));
  }
  fail(`${what} never confirmed in ${PATIENCE_MS / 60000} min: ${txid}`);
};

const waitForHeight = async (height) => {
  const until = Date.now() + PATIENCE_MS;
  let said = 0;
  while (Date.now() < until) {
    const tip = await tipHeight(SIGNET).catch(() => 0);
    if (tip >= height) return tip;
    const mins = Math.round((Date.now() - (until - PATIENCE_MS)) / 60000);
    if (mins >= said + 5) { say(`  still waiting for block ${height} (${mins} min, tip ${tip})`); said = mins; }
    await new Promise((r) => setTimeout(r, 15000));
  }
  fail(`signet never reached block ${height} in ${PATIENCE_MS / 60000} min`);
};

say("\n--- happy path: lock, then claim with the secret ---");
remember({ chain: SIGNET, address: lock.address, script: lock.script, terms, preimage: secret.preimage, claimKey, refundKey, note: "signet proof, happy path" });
const fund1 = fundHtlc(spendable, LOCK_AMOUNT, lock.address);
const fund1Id = await broadcast(SIGNET, hex(fund1.extract()));
say("funded:", fund1Id);
const fund1Height = await waitFor(fund1Id, "funding");
say("confirmed in block", fund1Height);

const locked = await utxos(SIGNET, lock.address);
if (locked.length !== 1 || locked[0].value !== LOCK_AMOUNT) fail(`expected ${LOCK_AMOUNT} sats locked, saw ${JSON.stringify(locked.map(String))}`);
say("the htlc holds", locked[0].value, "sats");

// The timeout is checked HERE, where earliness is guaranteed: this lock's deadline
// is still blocks away. Assert that premise out loud before believing the result.
const tipNow = await tipHeight(SIGNET);
if (tipNow >= terms.timeoutBlock) {
  fail(`cannot test the timeout: the chain is at ${tipNow}, the deadline was ${terms.timeoutBlock}`);
}
say(`chain is at ${tipNow}, the deadline is ${terms.timeoutBlock} — a refund now is genuinely early`);
let refusedEarly = false;
try {
  const early = refundTx({ chain: SIGNET, script: lock.script, utxos: locked, to: walletAddr, feeSats: FEE, privateKey: refundKey });
  await broadcast(SIGNET, hex(early.extract()));
} catch { refusedEarly = true; }
if (!refusedEarly) fail("a refund before the timeout was accepted — the timeout means nothing");
say("a refund before the timeout is rejected");

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

remember({ chain: SIGNET, address: lock2.address, script: lock2.script, terms: terms2, preimage: null, claimKey, refundKey, note: "signet proof, refund path — no secret by design" });
const fund2 = fundHtlc((await utxos(SIGNET, walletAddr)).filter((u) => u.confirmed), LOCK_AMOUNT, lock2.address);
const fund2Id = await broadcast(SIGNET, hex(fund2.extract()));
say("funded:", fund2Id);
await waitFor(fund2Id, "second funding");
const locked2 = await utxos(SIGNET, lock2.address);
say("the htlc holds", locked2[0].value, "sats");

say("waiting for block", terms2.timeoutBlock, "...");
say("tip is", await waitForHeight(terms2.timeoutBlock));

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
