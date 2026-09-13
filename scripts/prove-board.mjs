#!/usr/bin/env node
// Proof that the board is real: publish an intent to public relays we do not run,
// then fetch it back over a FRESH connection and check it survived intact.
//
// Costs nothing and moves nothing. The intent is signed by a throwaway wallet with
// no money, and carries a short expiry (NIP-40) so relays drop it by themselves.
import { ethers } from "ethers";
import { writeFileSync, mkdirSync } from "node:fs";
import { buildOrder, signOrder } from "../src/offer.mjs";
import { publish, fetchIntents, toNote, fromNote } from "../src/board.mjs";
import seaport from "../src/settle-seaport.mjs";
import { DEFAULT_RELAYS } from "../src/constants.mjs";

const LIVE = process.argv.includes("--publish");
const relays = process.env.RELAYS?.split(",") ?? DEFAULT_RELAYS;

// A wallet with nothing in it. The point is the board, not the money: a reader
// must be able to receive this, verify the signature, and then refuse to fill it.
const ghost = ethers.Wallet.createRandom();
const intent = seaport.fromSigned(await signOrder(ghost, buildOrder({
  offerer: ghost.address,
  give: { token: "USDC", amount: "0.01" },
  want: { token: "EURC", amount: "0.01" },
  expirySeconds: 600,
})));

console.log(`intent ${intent.id}`);
console.log(`  ${intent.give.amount} @ ${intent.give.asset}  ->  ${intent.want.amount} @ ${intent.want.asset}`);
console.log(`  settle ${intent.settle}, expires in 10 minutes`);

if (!LIVE) {
  const back = fromNote({ ...toNote(intent), id: "x", pubkey: "x", sig: "x" });
  console.log(`\nlocal round trip: ${back.ok ? "survives" : "BROKEN — " + back.reason}`);
  console.log("Nothing was published. To publish for real: node scripts/prove-board.mjs --publish");
  process.exit(back.ok ? 0 : 1);
}

console.log(`\npublishing to ${relays.length} relays we do not operate`);
const pub = await publish(intent, { relays });
console.log(`  event ${pub.event.id}`);
console.log(`  accepted by ${pub.accepted}/${pub.attempted}`);

// Fresh pool, fresh sockets, filtering only by the settlement method: exactly what
// a stranger's client would do, knowing nothing but the tag.
console.log("\nfetching back over a new connection, filtering on settle=seaport-1.6");
await new Promise((r) => setTimeout(r, 2500));
const found = await fetchIntents({ relays, settle: "seaport-1.6", limit: 100 });
const mine = found.find((f) => f.intent.id === intent.id);

console.log(`  ${found.length} valid intent(s) came back`);
console.log(`  ours: ${mine ? "found" : "NOT FOUND"}`);

let intact = false;
if (mine) {
  intact = mine.intent.proof === intent.proof
    && mine.intent.give.amount === intent.give.amount
    && mine.intent.want.amount === intent.want.amount
    && mine.settled.signed.parameters.offerer.toLowerCase() === ghost.address.toLowerCase();
  console.log(`  signature and both legs intact: ${intact}`);
  console.log(`  a reader verified it came from ${mine.settled.signed.parameters.offerer} without asking anyone`);
}

mkdirSync("proofs", { recursive: true });
const out = `proofs/board-${intent.id.slice(2, 12)}.json`;
writeFileSync(out, JSON.stringify({
  what: "an intent published to public relays and read back by a fresh client, with nothing of ours in between",
  relays, intentId: intent.id, nostrEventId: pub.event.id,
  acceptedBy: pub.accepted, attempted: pub.attempted,
  fetchedBack: !!mine, intactAfterRoundTrip: intact,
  maker: ghost.address, settle: intent.settle,
  at: new Date().toISOString(),
}, null, 2));

const ok = pub.accepted > 0 && !!mine && intact;
console.log(`\n${ok ? "PROVEN" : "FAILED"}: the board works without us.`);
console.log(`proof written to ${out}`);
process.exit(ok ? 0 : 1);
