// The Bitcoin half of a cross-chain swap: one output that two people can spend,
// under conditions neither of them can change afterwards.
//
//   claim  — whoever knows the preimage, signing with the claim key
//   refund — the funder, but only after a block height has passed
//
// The same SHA256 hash locks the EVM side (contracts/ERC20Swap.sol). One secret,
// two chains: revealing it on one chain reveals it on the other. That is the whole
// trick, and it needs no server, no escrow, and no trust between the two peers.

import * as btc from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha2.js";
import { hexToBytes, bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export const NETWORKS = {
  // CAIP-2 genesis hashes, so an intent names the chain the same way everywhere.
  "bip122:000000000019d6689c085ae165831e93": { name: "mainnet", params: btc.NETWORK, esplora: "https://blockstream.info/api" },
  "bip122:00000008819873e925422c1ff0f99f7c": { name: "signet", params: btc.TEST_NETWORK, esplora: "https://mempool.space/signet/api" },
};

export const asBytes = (x) => (typeof x === "string" ? hexToBytes(x.replace(/^0x/, "")) : x);
export const hex = (x) => bytesToHex(asBytes(x));

/** A secret and its hash. The hash goes in both locks; the secret unlocks both. */
export function newSecret() {
  const preimage = randomBytes(32);
  return { preimage: hex(preimage), hash: hex(sha256(preimage)) };
}

export const pubkey = (priv) => hex(secp256k1.getPublicKey(asBytes(priv), true));

/**
 * The locking script. Deliberately the shape Boltz uses, because it is the one
 * that has been in production longest:
 *
 *   OP_SHA256 <hash> OP_EQUAL
 *   OP_IF  <claimPubkey>
 *   OP_ELSE <timeout> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPubkey>
 *   OP_ENDIF
 *   OP_CHECKSIG
 *
 * The preimage sits on the stack as the IF condition, so a claim spend is
 * <signature> <preimage>, and a refund spend is <signature> <empty>. No branch
 * flag to get wrong.
 */
export function htlcScript({ hash, claimPubkey, refundPubkey, timeoutBlock }) {
  const h = asBytes(hash);
  if (h.length !== 32) throw new Error(`hash must be 32 bytes, got ${h.length}`);
  const claim = asBytes(claimPubkey);
  const refund = asBytes(refundPubkey);
  for (const [name, k] of [["claimPubkey", claim], ["refundPubkey", refund]]) {
    if (k.length !== 33) throw new Error(`${name} must be a 33-byte compressed pubkey, got ${k.length}`);
  }
  if (!Number.isInteger(timeoutBlock) || timeoutBlock <= 0) throw new Error("timeoutBlock must be a positive block height");
  // Above 500000000 a locktime means a unix timestamp, not a height. Silently
  // switching units would produce a lock that opens at the wrong time.
  if (timeoutBlock >= 500000000) throw new Error("timeoutBlock must be a block height, not a timestamp");

  return btc.Script.encode([
    "SHA256", h, "EQUAL",
    "IF", claim,
    "ELSE", btc.ScriptNum().encode(BigInt(timeoutBlock)), "CHECKLOCKTIMEVERIFY", "DROP", refund,
    "ENDIF", "CHECKSIG",
  ]);
}

/** Script plus the address to send to. P2WSH: the script is revealed only when spent. */
export function htlcAddress(terms, chain) {
  const net = NETWORKS[chain];
  if (!net) throw new Error(`unknown bitcoin chain ${chain}`);
  const script = htlcScript(terms);
  const out = btc.p2wsh({ type: "wsh", script }, net.params);
  return { address: out.address, script: hex(script), network: net.name };
}

/**
 * Read the terms back out of a script. An address alone proves nothing — a peer
 * must be able to check that the address they are about to fund really encodes
 * the hash, keys and timeout that were agreed.
 */
export function readScript(script) {
  const ops = btc.Script.decode(asBytes(script));
  const shape = ops.map((o) => (typeof o === "string" ? o : "DATA"));
  const expected = ["SHA256", "DATA", "EQUAL", "IF", "DATA", "ELSE", "DATA", "CHECKLOCKTIMEVERIFY", "DROP", "DATA", "ENDIF", "CHECKSIG"];
  if (shape.join(" ") !== expected.join(" ")) throw new Error(`not an HTLC script: ${shape.join(" ")}`);
  return {
    hash: hex(ops[1]),
    claimPubkey: hex(ops[4]),
    timeoutBlock: Number(btc.ScriptNum().decode(ops[6])),
    refundPubkey: hex(ops[9]),
  };
}

/** Does this address really lock these terms? Checked by rebuilding it. */
export function verifyAddress(address, terms, chain) {
  const built = htlcAddress(terms, chain);
  return built.address === address;
}

// ---------------------------------------------------------------------------
// Talking to the chain. Esplora's public API, read-only plus broadcast — no key
// ever leaves this process, and no account anywhere is needed.

async function esplora(chain, path, init) {
  const net = NETWORKS[chain];
  if (!net) throw new Error(`unknown bitcoin chain ${chain}`);
  const res = await fetch(`${net.esplora}${path}`, init);
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`esplora ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text;
}

export const tipHeight = async (chain) => Number(await esplora(chain, "/blocks/tip/height"));

/** Confirmed and unconfirmed outputs sitting at an address. */
export async function utxos(chain, address) {
  const list = JSON.parse(await esplora(chain, `/address/${address}/utxo`));
  return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed, height: u.status?.block_height ?? null }));
}

export const broadcast = (chain, txHex) =>
  esplora(chain, "/tx", { method: "POST", headers: { "Content-Type": "text/plain" }, body: txHex });

export const txStatus = async (chain, txid) => JSON.parse(await esplora(chain, `/tx/${txid}/status`));

// ---------------------------------------------------------------------------
// Spending. Both paths build the same transaction shape; only the witness and the
// locktime differ. Fees are explicit in satoshis: a swap where the fee is a
// surprise is a swap that loses money.

const spend = ({ chain, script, from, to, feeSats, locktime, privateKey, witness }) => {
  const net = NETWORKS[chain];
  if (!net) throw new Error(`unknown bitcoin chain ${chain}`);
  const scriptBytes = asBytes(script);
  const witnessScript = btc.p2wsh({ type: "wsh", script: scriptBytes }, net.params);
  const total = from.reduce((sum, u) => sum + u.value, 0n);
  const fee = BigInt(feeSats);
  if (fee <= 0n) throw new Error("feeSats must be positive");
  if (total <= fee) throw new Error(`nothing left after fee: have ${total} sats, fee ${fee} sats`);

  const tx = new btc.Transaction({ allowUnknownOutputs: false, lockTime: locktime ?? 0 });
  for (const u of from) {
    tx.addInput({
      txid: asBytes(u.txid),
      index: u.vout,
      witnessUtxo: { script: witnessScript.script, amount: u.value },
      witnessScript: scriptBytes,
      // A CLTV spend is invalid with a final sequence. Refunds must signal it;
      // claims may, and using the same value for both keeps the shape uniform.
      sequence: 0xfffffffe,
    });
  }
  tx.addOutputAddress(to, total - fee, net.params);

  // signIdx leaves a partialSig; finalizeIdx refuses a script it does not
  // recognise ("Unknown inputs not allowed"), which ours never will be. So the
  // witness is assembled here, explicitly, from the signature it produced.
  for (let i = 0; i < from.length; i++) {
    tx.signIdx(asBytes(privateKey), i);
    const sig = tx.getInput(i).partialSig?.[0]?.[1];
    if (!sig) throw new Error(`input ${i} did not get signed`);
    tx.updateInput(i, { partialSig: undefined, finalScriptWitness: witness(sig) });
  }
  return tx;
};

/** Spend with the secret. Witness: <signature> <preimage> <script>. */
export function claimTx({ chain, script, utxos: from, to, feeSats, preimage, privateKey }) {
  const terms = readScript(script);
  const secret = asBytes(preimage);
  if (hex(sha256(secret)) !== terms.hash) throw new Error("preimage does not match the hash in this script");
  if (pubkey(privateKey) !== terms.claimPubkey) throw new Error("this key is not the claim key in this script");

  return spend({
    chain, script, from, to, feeSats, locktime: 0,
    privateKey,
    // Preimage on the stack takes the IF branch.
    witness: (sig) => [sig, secret, asBytes(script)],
  });
}

/** Spend after the timeout. Witness: <signature> <empty> <script>. */
export function refundTx({ chain, script, utxos: from, to, feeSats, privateKey }) {
  const terms = readScript(script);
  if (pubkey(privateKey) !== terms.refundPubkey) throw new Error("this key is not the refund key in this script");

  return spend({
    chain, script, from, to, feeSats,
    // The locktime must be at least the height in the script, and the spend is
    // only valid once the chain is past it. Setting it lower makes the script fail.
    locktime: terms.timeoutBlock,
    privateKey,
    // Empty element takes the ELSE branch.
    witness: (sig) => [sig, new Uint8Array(0), asBytes(script)],
  });
}

/** The secret, read back out of a claim transaction on chain. */
export function preimageFromWitness(txHex) {
  const tx = btc.Transaction.fromRaw(asBytes(txHex), { allowUnknownInputs: true });
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).finalScriptWitness;
    if (w?.length === 3 && w[1]?.length === 32) return hex(w[1]);
  }
  return null;
}
