// Take an offer. Everything here runs BEFORE any gas is spent: a stale offer must
// cost the taker one RPC round trip, never a failed transaction.
import { ethers } from "ethers";
import { CHAIN_ID, SEAPORT, DEFAULT_RPCS } from "./constants.mjs";
import { orderHash, signatureMatchesOfferer } from "./offer.mjs";

export const SEAPORT_ABI = [
  "function information() view returns (string version, bytes32 domainSeparator, address conduitController)",
  "function getCounter(address offerer) view returns (uint256)",
  "function getOrderHash((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter) order) view returns (bytes32)",
  "function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)",
  "function fulfillOrder(((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems) parameters,bytes signature) order, bytes32 fulfillerConduitKey) payable returns (bool fulfilled)",
  "function cancel((address offerer,address zone,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)[] offer,(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)[] orders) returns (bool cancelled)",
];

export const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

export async function connect(urls = DEFAULT_RPCS) {
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
      if (Number((await p.getNetwork()).chainId) === CHAIN_ID) return p;
    } catch { /* a dead RPC is not an answer; try the next */ }
  }
  throw new Error("no Base RPC reachable");
}

export const seaport = (runner) => new ethers.Contract(SEAPORT, SEAPORT_ABI, runner);

// Seaport's fulfillOrder wants totalOriginalConsiderationItems where the signed
// order carries counter. Same struct otherwise; getting this wrong reverts.
export function toAdvanced(signed) {
  const { counter, ...rest } = signed.parameters;
  return {
    parameters: { ...rest, totalOriginalConsiderationItems: signed.parameters.consideration.length },
    signature: signed.signature,
  };
}

// Every reason an offer cannot be taken, checked in cost order: free checks first,
// then one batch of RPC reads, then a simulation of the exact transaction.
export async function check(signed, { provider, taker, now } = {}) {
  const p = provider ?? await connect();
  const o = signed.parameters;
  const problems = [];
  const at = now ?? (await p.getBlock("latest")).timestamp;

  if (!signatureMatchesOfferer(signed)) problems.push("signature does not belong to the maker");
  if (Number(o.endTime) <= at) problems.push("offer has expired");
  if (Number(o.startTime) > at) problems.push("offer is not active yet");
  if (problems.length) return { fillable: false, problems, hash: orderHash(o) };

  const sea = seaport(p);
  const hash = await sea.getOrderHash(o);
  if (hash !== orderHash(o)) problems.push("order hash disagrees with Seaport");

  const give = o.offer[0], want = o.consideration[0];
  const [status, counter, makerBal, makerAllow] = await Promise.all([
    sea.getOrderStatus(hash),
    sea.getCounter(o.offerer),
    new ethers.Contract(give.token, ERC20_ABI, p).balanceOf(o.offerer),
    new ethers.Contract(give.token, ERC20_ABI, p).allowance(o.offerer, SEAPORT),
  ]);

  if (status.isCancelled) problems.push("maker cancelled this offer");
  if (status.totalFilled > 0n) problems.push("offer was already taken");
  // The maker can invalidate every open offer at once by bumping their counter.
  if (BigInt(o.counter) !== counter) problems.push("maker cancelled all their offers");
  if (makerBal < BigInt(give.startAmount)) problems.push("maker no longer has the tokens");
  if (makerAllow < BigInt(give.startAmount)) problems.push("maker withdrew their approval");

  if (taker) {
    const t = new ethers.Contract(want.token, ERC20_ABI, p);
    const [bal, allow] = await Promise.all([t.balanceOf(taker), t.allowance(taker, SEAPORT)]);
    if (bal < BigInt(want.startAmount)) problems.push("you do not have enough to pay for this");
    if (allow < BigInt(want.startAmount)) problems.push("you have not approved Seaport yet");
  }

  return { fillable: problems.length === 0, problems, hash, status, counter };
}

// The last gate: ask the chain to run the exact transaction without sending it.
// Anything that would revert, reverts here instead — for free.
export async function simulate(signed, { provider, taker }) {
  const p = provider ?? await connect();
  try {
    await seaport(p).fulfillOrder.staticCall(toAdvanced(signed), "0x" + "00".repeat(32), { from: taker });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.shortMessage ?? e.message };
  }
}

// Send it. Refuses unless check and simulate both passed on the same data.
export async function fill(signed, { wallet, provider }) {
  const p = provider ?? wallet.provider ?? await connect();
  const taker = await wallet.getAddress();

  const pre = await check(signed, { provider: p, taker });
  if (!pre.fillable) throw new Error(`cannot take this offer: ${pre.problems.join("; ")}`);
  const sim = await simulate(signed, { provider: p, taker });
  if (!sim.ok) throw new Error(`simulation failed: ${sim.reason}`);

  const tx = await seaport(wallet).fulfillOrder(toAdvanced(signed), "0x" + "00".repeat(32));
  return { tx, receipt: await tx.wait() };
}

// Withdraw an offer on chain, so nobody can take it afterwards.
export async function cancel(order, { wallet }) {
  const tx = await seaport(wallet).cancel([order]);
  return { tx, receipt: await tx.wait() };
}

// One approval per token, for exactly the amount an offer needs.
export async function approve(token, amount, { wallet }) {
  const tx = await new ethers.Contract(token, ERC20_ABI, wallet).approve(SEAPORT, amount);
  return { tx, receipt: await tx.wait() };
}
