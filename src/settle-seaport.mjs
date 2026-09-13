// Settlement method: Seaport 1.6 on Base.
// Two ERC-20 legs on one chain, moved in a single transaction. Anyone may fill.
import { ethers } from "ethers";
import { register, CHAINS } from "./settle.mjs";
import { CHAIN_ID, SEAPORT } from "./constants.mjs";
import { orderHash, signatureMatchesOfferer } from "./offer.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const Z32 = "0x" + "00".repeat(32);

export default register({
  id: "seaport-1.6",

  // Turn a signed Seaport order into the universal shape the board carries.
  fromSigned(signed) {
    const p = signed.parameters;
    return {
      settle: "seaport-1.6",
      by: p.offerer,
      give: { chain: CHAINS.base, asset: p.offer[0].token, amount: p.offer[0].startAmount },
      want: { chain: CHAINS.base, asset: p.consideration[0].token, amount: p.consideration[0].startAmount },
      expiry: Number(p.endTime),
      id: orderHash(p),
      terms: { contract: SEAPORT, order: p },
      proof: signed.signature,
    };
  },

  // Read it back, refusing anything a taker must not act on. Cheap checks only:
  // no network here, so a hostile intent costs a reader nothing.
  parse(intent, { now }) {
    const o = intent?.terms?.order;
    const bad = (reason) => ({ ok: false, reason });
    if (!o) return bad("malformed_order");
    if (intent.terms.contract?.toLowerCase() !== SEAPORT.toLowerCase()) return bad("unknown_settlement_contract");
    if (intent.give?.chain !== CHAINS.base || intent.want?.chain !== CHAINS.base) return bad("wrong_chain");
    if (o.offer?.length !== 1 || o.consideration?.length !== 1) return bad("unsupported_shape");
    if (o.zone !== ZERO) return bad("has_zone");
    if (o.conduitKey !== Z32) return bad("has_conduit");
    if (Number(o.endTime) <= now) return bad("expired");

    const signed = { parameters: o, signature: intent.proof };
    if (!signatureMatchesOfferer(signed, CHAIN_ID, intent.terms.contract)) return bad("bad_signature");
    // The legs a reader filters on must match the order that actually executes.
    if (o.offer[0].token.toLowerCase() !== intent.give.asset.toLowerCase()
      || o.offer[0].startAmount !== intent.give.amount
      || o.consideration[0].token.toLowerCase() !== intent.want.asset.toLowerCase()
      || o.consideration[0].startAmount !== intent.want.amount) return bad("summary_disagrees_with_terms");

    return { ok: true, signed, id: orderHash(o) };
  },

  // What a person is told they would be doing.
  describe: () => "Both sides move in one transaction on Base. Anyone can take it.",
});
