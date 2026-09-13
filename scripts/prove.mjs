#!/usr/bin/env node
// The proof: one real swap between two wallets on Base, verified from outside.
//
// Nothing here runs without --execute, and --execute needs two keys you supply.
// Read-only by default: `node scripts/prove.mjs` prints what it would do.
import { ethers } from "ethers";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildOrder, signOrder, orderHash } from "../src/offer.mjs";
import { connect, check, simulate, fill, approve, ERC20_ABI } from "../src/fill.mjs";
import { toNote, fromNote } from "../src/board.mjs";
import { SEAPORT, TOKENS, CHAIN_ID } from "../src/constants.mjs";

const EXECUTE = process.argv.includes("--execute");
const GIVE = { token: "USDC", amount: process.env.PROVE_GIVE ?? "0.01" };
const WANT = { token: "EURC", amount: process.env.PROVE_WANT ?? "0.01" };

const bal = (p, t, who) => new ethers.Contract(t, ERC20_ABI, p).balanceOf(who);
const fmt = (v, d) => ethers.formatUnits(v, d);

const p = await connect();
console.log(`Base chainId ${CHAIN_ID}, block ${await p.getBlockNumber()}`);
console.log(`Seaport      ${SEAPORT}`);
console.log(`maker gives  ${GIVE.amount} ${GIVE.token}`);
console.log(`taker gives  ${WANT.amount} ${WANT.token}`);

if (!EXECUTE) {
  console.log("\nDry run. Nothing was sent, no key was read.");
  console.log("To run for real: PROVE_MAKER_KEY=0x.. PROVE_TAKER_KEY=0x.. node scripts/prove.mjs --execute");
  process.exit(0);
}

const makerKey = process.env.PROVE_MAKER_KEY, takerKey = process.env.PROVE_TAKER_KEY;
if (!makerKey || !takerKey) { console.error("need PROVE_MAKER_KEY and PROVE_TAKER_KEY"); process.exit(1); }
const maker = new ethers.Wallet(makerKey, p), taker = new ethers.Wallet(takerKey, p);
if (maker.address === taker.address) { console.error("maker and taker must be different wallets"); process.exit(1); }

const giveT = TOKENS[GIVE.token], wantT = TOKENS[WANT.token];
const giveUnits = ethers.parseUnits(GIVE.amount, giveT.decimals);
const wantUnits = ethers.parseUnits(WANT.amount, wantT.decimals);

const before = {
  makerGive: await bal(p, giveT.address, maker.address), makerWant: await bal(p, wantT.address, maker.address),
  takerGive: await bal(p, giveT.address, taker.address), takerWant: await bal(p, wantT.address, taker.address),
};
console.log(`\nbefore  maker ${fmt(before.makerGive, giveT.decimals)} ${GIVE.token} / ${fmt(before.makerWant, wantT.decimals)} ${WANT.token}`);
console.log(`before  taker ${fmt(before.takerGive, giveT.decimals)} ${GIVE.token} / ${fmt(before.takerWant, wantT.decimals)} ${WANT.token}`);

console.log("\napproving Seaport for exactly this amount on both sides");
const aM = await approve(giveT.address, giveUnits, { wallet: maker });
const aT = await approve(wantT.address, wantUnits, { wallet: taker });
console.log(`  maker approve ${aM.tx.hash}`);
console.log(`  taker approve ${aT.tx.hash}`);

const order = buildOrder({ offerer: maker.address, give: GIVE, want: WANT, expirySeconds: 900 });
const signed = await signOrder(maker, order);
const hash = orderHash(order);
console.log(`\norder hash ${hash}`);

// Round trip through the board format, exactly as another peer would receive it.
const parsed = fromNote({ ...toNote(signed), id: "x", pubkey: "x", sig: "x" });
if (!parsed.ok) { console.error("the offer does not survive the board format:", parsed.reason); process.exit(1); }

const gate = await check(parsed.signed, { provider: p, taker: taker.address });
console.log("check:", gate.fillable ? "fillable" : `refused — ${gate.problems.join("; ")}`);
if (!gate.fillable) process.exit(1);
const sim = await simulate(parsed.signed, { provider: p, taker: taker.address });
console.log("simulate:", sim.ok ? "would succeed" : `would revert — ${sim.reason}`);
if (!sim.ok) process.exit(1);

console.log("\nfilling");
const { tx, receipt } = await fill(parsed.signed, { wallet: taker, provider: p });
console.log(`  tx ${tx.hash}  block ${receipt.blockNumber}  status ${receipt.status}`);

const after = {
  makerGive: await bal(p, giveT.address, maker.address), makerWant: await bal(p, wantT.address, maker.address),
  takerGive: await bal(p, giveT.address, taker.address), takerWant: await bal(p, wantT.address, taker.address),
};
console.log(`after   maker ${fmt(after.makerGive, giveT.decimals)} ${GIVE.token} / ${fmt(after.makerWant, wantT.decimals)} ${WANT.token}`);
console.log(`after   taker ${fmt(after.takerGive, giveT.decimals)} ${GIVE.token} / ${fmt(after.takerWant, wantT.decimals)} ${WANT.token}`);

// Both legs must have moved by exactly the agreed amounts, in one transaction.
const ok = before.makerGive - after.makerGive === giveUnits
        && after.makerWant - before.makerWant === wantUnits
        && after.takerGive - before.takerGive === giveUnits
        && before.takerWant - after.takerWant === wantUnits;

mkdirSync("proofs", { recursive: true });
const out = `proofs/fill-${hash.slice(2, 12)}.json`;
writeFileSync(out, JSON.stringify({
  what: "one peer-to-peer swap, settled by Seaport in a single transaction",
  chainId: CHAIN_ID, seaport: SEAPORT, orderHash: hash,
  maker: maker.address, taker: taker.address,
  gave: { token: giveT.address, symbol: GIVE.token, units: giveUnits.toString() },
  got: { token: wantT.address, symbol: WANT.token, units: wantUnits.toString() },
  approvals: { maker: aM.tx.hash, taker: aT.tx.hash },
  fillTx: tx.hash, block: receipt.blockNumber, receiptStatus: receipt.status,
  balances: {
    before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.toString()])),
    after: Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v.toString()])),
  },
  bothLegsMoved: ok, at: new Date().toISOString(),
}, null, 2));

console.log(`\n${ok ? "PROVEN" : "MISMATCH"}: both legs moved in tx ${tx.hash}`);
console.log(`proof written to ${out}`);
process.exit(ok ? 0 : 1);
