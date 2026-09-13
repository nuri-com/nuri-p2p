// Build and sign an offer. An offer is a signed piece of text, not a transfer:
// the maker's tokens stay in the maker's wallet until somebody executes it.
import { ethers } from "ethers";
import {
  CHAIN_ID, SEAPORT, TOKENS, ITEM_TYPE, ORDER_TYPE, DEFAULT_EXPIRY_SECONDS,
} from "./constants.mjs";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_BYTES32 = "0x" + "00".repeat(32);

// Seaport's EIP-712 types. Copied from the Seaport 1.6 source; the domain
// separator we build from these is asserted against the live contract in the tests,
// so a typo here fails loudly instead of producing an unfillable signature.
export const EIP712_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

export function domain(chainId = CHAIN_ID, verifyingContract = SEAPORT) {
  return { name: "Seaport", version: "1.6", chainId, verifyingContract };
}

function resolveToken(t) {
  if (typeof t === "string" && TOKENS[t]) return TOKENS[t];
  if (typeof t === "object" && t?.address) return t;
  throw new Error(`unknown token: ${JSON.stringify(t)}`);
}

export function toUnits(amount, token) {
  const { decimals } = resolveToken(token);
  return ethers.parseUnits(String(amount), decimals).toString();
}

// Build the order the maker will sign.
//   give:  what the maker sends     e.g. { token: "USDC", amount: "1.00" }
//   want:  what the maker receives  e.g. { token: "EURC", amount: "0.92" }
// The maker is also the recipient of `want`: Seaport pays the consideration
// straight to the address stored in the order, so a watcher cannot redirect it.
export function buildOrder({ offerer, give, want, expirySeconds = DEFAULT_EXPIRY_SECONDS, counter = 0, startTime, salt }) {
  if (!ethers.isAddress(offerer)) throw new Error("offerer must be an address");
  const giveToken = resolveToken(give.token);
  const wantToken = resolveToken(want.token);
  if (!(expirySeconds > 0)) throw new Error("expirySeconds must be positive");

  const start = startTime ?? Math.floor(Date.now() / 1000);
  const end = start + expirySeconds;
  const giveAmount = toUnits(give.amount, giveToken);
  const wantAmount = toUnits(want.amount, wantToken);
  if (giveAmount === "0" || wantAmount === "0") throw new Error("amounts must be greater than zero");

  return {
    offerer: ethers.getAddress(offerer),
    zone: ZERO_ADDRESS,
    offer: [{
      itemType: ITEM_TYPE.ERC20,
      token: ethers.getAddress(giveToken.address),
      identifierOrCriteria: "0",
      startAmount: giveAmount,
      endAmount: giveAmount,
    }],
    consideration: [{
      itemType: ITEM_TYPE.ERC20,
      token: ethers.getAddress(wantToken.address),
      identifierOrCriteria: "0",
      startAmount: wantAmount,
      endAmount: wantAmount,
      recipient: ethers.getAddress(offerer),
    }],
    orderType: ORDER_TYPE.FULL_OPEN,
    startTime: String(start),
    endTime: String(end),
    zoneHash: ZERO_BYTES32,
    salt: salt ?? ethers.hexlify(ethers.randomBytes(32)),
    conduitKey: ZERO_BYTES32,
    counter: String(counter),
  };
}

// Seaport calls the struct hash "the order hash" — it is what getOrderHash returns
// and what the contract stores. It carries no chain or contract, so it is the same
// value everywhere; the domain only enters at signing time.
export function orderHash(order) {
  return ethers.TypedDataEncoder.hashStruct("OrderComponents", EIP712_TYPES, order);
}

// What the wallet actually signs: keccak(0x1901 || domainSeparator || orderHash).
export function signingDigest(order, chainId = CHAIN_ID, verifyingContract = SEAPORT) {
  return ethers.TypedDataEncoder.hash(domain(chainId, verifyingContract), EIP712_TYPES, order);
}

export async function signOrder(signer, order, chainId = CHAIN_ID, verifyingContract = SEAPORT) {
  const signature = await signer.signTypedData(domain(chainId, verifyingContract), EIP712_TYPES, order);
  return { parameters: order, signature };
}

// Recover the signer and confirm it is the offerer named in the order.
// A signature from anyone else is not an authorization to spend the offerer's tokens.
export function recoverSigner(signed, chainId = CHAIN_ID, verifyingContract = SEAPORT) {
  return ethers.verifyTypedData(domain(chainId, verifyingContract), EIP712_TYPES, signed.parameters, signed.signature);
}

export function signatureMatchesOfferer(signed, chainId = CHAIN_ID, verifyingContract = SEAPORT) {
  try {
    return recoverSigner(signed, chainId, verifyingContract).toLowerCase()
      === signed.parameters.offerer.toLowerCase();
  } catch {
    return false;
  }
}
