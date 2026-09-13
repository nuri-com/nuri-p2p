// These tests talk to Base. They read only: no transaction, no key, no money.
// They exist because a typo in our EIP-712 types would produce a signature that
// looks fine locally and is unfillable on chain. Only the contract can settle that.
import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildOrder, orderHash, domain, EIP712_TYPES } from "../src/offer.mjs";
import { CHAIN_ID, SEAPORT, CONDUIT_CONTROLLER, TOKENS, DEFAULT_RPCS } from "../src/constants.mjs";

const SEAPORT_ABI = [
  "function information() view returns (string version, bytes32 domainSeparator, address conduitController)",
  "function getCounter(address offerer) view returns (uint256)",
  "function getOrderHash((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter) order) view returns (bytes32)",
];

async function provider() {
  for (const url of DEFAULT_RPCS) {
    try {
      const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
      if (Number((await p.getNetwork()).chainId) === CHAIN_ID) return p;
    } catch { /* try the next one; a dead RPC is not a failed test */ }
  }
  return null;
}

const p = await provider();
const online = { skip: p ? false : "no Base RPC reachable" };

test("Seaport 1.6 is deployed at the address we hard-coded", online, async () => {
  const info = await new ethers.Contract(SEAPORT, SEAPORT_ABI, p).information();
  assert.equal(info.version, "1.6");
  assert.equal(ethers.getAddress(info.conduitController), ethers.getAddress(CONDUIT_CONTROLLER));
});

test("our EIP-712 domain matches the contract's own separator", online, async () => {
  const info = await new ethers.Contract(SEAPORT, SEAPORT_ABI, p).information();
  assert.equal(ethers.TypedDataEncoder.hashDomain(domain()), info.domainSeparator);
});

test("Seaport hashes our order to exactly what we hash it to", online, async () => {
  const order = buildOrder({
    offerer: "0x1111111111111111111111111111111111111111",
    give: { token: "USDC", amount: "1.0" },
    want: { token: "EURC", amount: "0.92" },
    startTime: 1_800_000_000, salt: "0x" + "ab".repeat(32),
  });
  const onChain = await new ethers.Contract(SEAPORT, SEAPORT_ABI, p).getOrderHash(order);
  assert.equal(orderHash(order), onChain);
});

test("the tokens we quote are real contracts on Base", online, async () => {
  for (const t of Object.values(TOKENS)) {
    assert.notEqual(await p.getCode(t.address), "0x", `${t.symbol} has no code`);
    const dec = await new ethers.Contract(t.address, ["function decimals() view returns (uint8)"], p).decimals();
    assert.equal(Number(dec), t.decimals, `${t.symbol} decimals`);
  }
});

test("EIP712_TYPES is not silently empty", () => {
  assert.equal(EIP712_TYPES.OrderComponents.length, 11);
});
