// Everything that is not ours, and the exact values we depend on.
// Verified live against Base (chainId 8453) on 2026-09-13.

export const CHAIN_ID = 8453;

// Seaport 1.6 — the settlement contract. Audited, deployed, not written by us.
// information() on this address returns version "1.6".
export const SEAPORT = "0x0000000000000068F116a894984e2DB1123eB395";

// Seaport's conduit controller, as reported by information().
export const CONDUIT_CONTROLLER = "0x00000000F9490004C11Cef243f5400493c00Ad63";

export const TOKENS = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6, symbol: "EURC" },
};

// Seaport enums we use. Full list lives in the Seaport docs; we only need these.
export const ITEM_TYPE = { ERC20: 1 };
export const ORDER_TYPE = { FULL_OPEN: 0 }; // anyone may fill, all-or-nothing

// Nostr event kind for peer-to-peer trade offers, as used in the wild today
// (observed on wss://relay.damus.io, 2026-09-13).
export const OFFER_KIND = 38383;

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

export const DEFAULT_RPCS = [
  "https://1rpc.io/base",
  "https://base-rpc.publicnode.com",
  "https://mainnet.base.org",
  "https://base.drpc.org",
];

// Ordered by measured behavior, 2026-09-13: ethers batches concurrent reads, and
// not every public endpoint honors batches. mainnet.base.org mangles them
// ("missing revert data" on calls that succeed alone); drpc's free plan rejects
// batches over 3. publicnode and 1rpc handle full batches. First working wins.
// A swap offer is worthless once stale, and a long-lived offer is a free option
// for whoever takes it. One hour is the default; callers may shorten it.
export const DEFAULT_EXPIRY_SECONDS = 3600;
