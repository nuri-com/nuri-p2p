#!/usr/bin/env node
// The evil twin. A signed offer is not a promise: the maker can spend the money
// afterwards. This proves the taker finds out for free, before spending gas.
//
// Dry by default. --execute needs one funded wallet and moves its own tokens away.
import { ethers } from "ethers";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildOrder, signOrder, orderHash } from "../src/offer.mjs";
import { connect, check, simulate, approve, ERC20_ABI } from "../src/fill.mjs";
import { TOKENS, CHAIN_ID, SEAPORT } from "../src/constants.mjs";

const EXECUTE = process.argv.includes("--execute");
const p = await connect();

if (!EXECUTE) {
  // Offline version of the same story: a maker with nothing is refused for free.
  const ghost = ethers.Wallet.createRandom();
  const signed = await signOrder(ghost, buildOrder({
    offerer: ghost.address,
    give: { token: "USDC", amount: "0.01" }, want: { token: "EURC", amount: "0.01" },
    startTime: Math.floor(Date.now() / 1000) - 600,
  }));
  const gate = await check(signed, { provider: p, taker: "0x2222222222222222222222222222222222222222" });
  console.log("offer from a wallet that owns nothing:");
  for (const why of gate.problems) console.log(`  refused: ${why}`);
  const refusedWithoutGas = !gate.fillable;
  console.log(`\n${refusedWithoutGas ? "PROVEN" : "FAILED"}: refused before any gas was spent.`);
  console.log("For the full version with a real maker: PROVE_MAKER_KEY=0x.. PROVE_SINK=0x.. node scripts/prove-stale.mjs --execute");
  process.exit(refusedWithoutGas ? 0 : 1);
}

const makerKey = process.env.PROVE_MAKER_KEY, sink = process.env.PROVE_SINK;
if (!makerKey || !sink) { console.error("need PROVE_MAKER_KEY and PROVE_SINK"); process.exit(1); }
const maker = new ethers.Wallet(makerKey, p);
const t = TOKENS.USDC, amount = ethers.parseUnits("0.01", t.decimals);
const token = new ethers.Contract(t.address, ERC20_ABI, maker);

console.log(`maker ${maker.address}`);
await approve(t.address, amount, { wallet: maker });

const signed = await signOrder(maker, buildOrder({
  offerer: maker.address, give: { token: "USDC", amount: "0.01" }, want: { token: "EURC", amount: "0.01" },
  startTime: Math.floor(Date.now() / 1000) - 60, expirySeconds: 900,
}));
const hash = orderHash(signed.parameters);
const takerAddr = "0x2222222222222222222222222222222222222222";

const beforeMove = await check(signed, { provider: p });
console.log(`offer ${hash}`);
console.log("before the maker moves the money:", beforeMove.problems.length ? beforeMove.problems.join("; ") : "no maker-side problem");

console.log(`\nmaker now sends the same tokens away to ${sink}`);
const away = await token.transfer(sink, amount);
await away.wait();
console.log(`  tx ${away.hash}`);

const afterMove = await check(signed, { provider: p, taker: takerAddr });
const sim = await simulate(signed, { provider: p, taker: takerAddr });
console.log("\nwhat a taker now sees:");
for (const why of afterMove.problems) console.log(`  refused: ${why}`);
console.log(`  simulation: ${sim.ok ? "would succeed (WRONG)" : `would revert — ${sim.reason}`}`);

const proven = !afterMove.fillable && !sim.ok
  && afterMove.problems.includes("maker no longer has the tokens");

mkdirSync("proofs", { recursive: true });
const out = `proofs/stale-${hash.slice(2, 12)}.json`;
writeFileSync(out, JSON.stringify({
  what: "a signed offer whose maker spent the money is refused before the taker spends gas",
  chainId: CHAIN_ID, seaport: SEAPORT, orderHash: hash, maker: maker.address,
  movedAwayTx: away.hash, problemsAfter: afterMove.problems,
  simulationReverted: !sim.ok, simulationReason: sim.reason ?? null,
  refusedBeforeGas: proven, at: new Date().toISOString(),
}, null, 2));

console.log(`\n${proven ? "PROVEN" : "FAILED"}: the taker is refused for free. Nobody lost anything.`);
console.log(`proof written to ${out}`);
process.exit(proven ? 0 : 1);
