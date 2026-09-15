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

export async function connect(urls = process.env.NURI_P2P_RPC ? [process.env.NURI_P2P_RPC] : DEFAULT_RPCS) {
  const healthy = [];
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
      // Probe with what we actually do: concurrent reads in one batch. A chainId
      // alone proves nothing — mainnet.base.org answers it and then mangles batches,
      // drpc's free plan rejects batches over 3, and free tiers throttle under load.
      // First endpoint that survives a real batch wins.
      const sea = new ethers.Contract(SEAPORT, ["function getCounter(address) view returns (uint256)"], p);
      const [chain, block, code, counter] = await Promise.all([
        p.getNetwork(),
        p.getBlockNumber(),
        p.getCode(SEAPORT),
        sea.getCounter("0x0000000000000000000000000000000000000001"),
      ]);
      if (Number(chain.chainId) === CHAIN_ID && block > 0 && code.length > 2 && counter === 0n) {
        healthy.push(p);
        break;
      }
    } catch { /* this endpoint is degraded; the next one gets its chance */ }
  }
  if (healthy.length === 0) throw new Error("no healthy Base RPC reachable");

  // Passing the health probe does not buy immunity. Under load, free endpoints
  // return a batch with responses *missing* — ethers surfaces that later as
  // BAD_DATA "missing response for request", which reads exactly like a failed
  // assertion three frames away from the real cause. Measured on 1rpc.io: 3 of 6
  // identical batch rounds came back short.
  //
  // So: after every batch, check that each request id got an answer, and re-ask
  // for the missing ones — first on this endpoint one at a time, then on the
  // spares. Somebody else's rate limit is not a test result.
  const primary = healthy[0];
  const spares = urls
    .filter((u) => u !== primary._getConnection().url)
    .map((u) => new ethers.JsonRpcProvider(u, CHAIN_ID, { staticNetwork: true }));

  const send = primary._send.bind(primary);

  // Retry one request. The primary uses the *unwrapped* send — calling the wrapper
  // from inside itself would recurse forever.
  const ask = async (sendOne, one) => {
    const r = await sendOne(one);
    return (Array.isArray(r) ? r : [r]).find((x) => x && x.id === one.id);
  };
  const retries = [send, ...spares.map((s) => s._send.bind(s))];

  primary._send = async (payload) => {
    const asked = Array.isArray(payload) ? payload : [payload];
    let got = [];
    try {
      const r = await send(payload);
      got = Array.isArray(r) ? r : [r];
    } catch { /* whole batch died; every id counts as missing */ }

    const answered = new Set(got.map((x) => x && x.id));
    for (const one of asked.filter((x) => !answered.has(x.id))) {
      let answer;
      for (const sendOne of retries) {
        try {
          answer = await ask(sendOne, one);
          if (answer) break;
        } catch { /* next endpoint */ }
      }
      got.push(answer ?? { id: one.id, jsonrpc: "2.0", error: { code: -32603, message: "no endpoint answered" } });
    }
    return got;
  };
  return primary;
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

  const req = await seaport(wallet).fulfillOrder.populateTransaction(toAdvanced(signed), "0x" + "00".repeat(32));
  return sendWithFreshNonce(wallet, req);
}

// Withdraw an offer on chain, so nobody can take it afterwards.
export async function cancel(order, { wallet }) {
  const req = await seaport(wallet).cancel.populateTransaction([order]);
  return sendWithFreshNonce(wallet, req);
}

// One approval per token, for exactly the amount an offer needs.
export async function approve(token, amount, { wallet }) {
  const req = await new ethers.Contract(token, ERC20_ABI, wallet).approve.populateTransaction(SEAPORT, amount);
  return sendWithFreshNonce(wallet, req);
}

// Wait for a receipt the hard way: poll across every endpoint we have, and treat
// a transport refusal as "not yet" rather than failure. Learned live: publicnode
// broadcasts fine and then answers the receipt poll with 403 "archive requests
// require a personal token". The transaction is on chain; only the waiting failed.
// Without this, a landed transaction reads as a failed one — the worst possible lie.
export async function waitForReceipt(hash, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  // Always every endpoint: rotation is the safety, and reads are free. A pinned
  // NURI_P2P_RPC must never narrow this — one endpoint's refusal to serve receipts
  // must not turn a landed transaction into a failed run.
  while (Date.now() < deadline) {
    for (const url of DEFAULT_RPCS) {
      try {
        const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
        const receipt = await p.getTransactionReceipt(hash);
        if (receipt) return receipt;
      } catch (e) { lastError = e; /* a refusal is not an answer; next endpoint */ }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`no receipt for ${hash} within ${timeoutMs}ms${lastError ? `: ${lastError.shortMessage ?? lastError.message}` : ""}`);
}

// A nonce read from one free endpoint can lag a block behind — we watched a fill
// die with "next nonce 3, tx nonce 2" because the endpoint had not seen our own
// approve yet. So: take the max across endpoints, and retry once on NONCE_EXPIRED
// with a fresh max. Two retries would mean the chain moved under us twice, which
// means something else is spending from this wallet — stop instead of guessing.
export async function sendWithFreshNonce(wallet, txRequest) {
  const addr = await wallet.getAddress();
  for (let attempt = 0; attempt < 2; attempt++) {
    const counts = await Promise.all(
      DEFAULT_RPCS.map(async (url) => {
        try {
          const p = new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true });
          return Number(await p.getTransactionCount(addr, "latest"));
        } catch { return -1; }
      }),
    );
    const nonce = Math.max(...counts);
    if (nonce < 0) throw new Error("no endpoint would report a nonce");
    try {
      const tx = await wallet.sendTransaction({ ...txRequest, nonce });
      return withReceipt(tx);
    } catch (e) {
      if (e.code !== "NONCE_EXPIRED" || attempt === 1) throw e;
      // Someone — possibly us, on a lagging endpoint — moved first. Re-read and retry once.
    }
  }
}

const withReceipt = async (tx) => ({ tx, receipt: await waitForReceipt(tx.hash) });
