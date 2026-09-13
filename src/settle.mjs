// What makes an intent fillable, and by what rules.
//
// An intent says "I give this, I want that". HOW it settles is a named method.
// Each method knows three things: can I read this, is the signature real, and
// what does a taker have to do. A reader that does not know a method skips it —
// which is how a new rail (Bitcoin, Lightning, an API call) gets added without
// touching the board, the page, or anybody else's client.
//
// The rule every method must satisfy to be listed here:
//   ANY taker can fill it. No allowlist, no registration, no operator.
// That is the whole point, and it is what rules out CoW: its settlement contract
// has onlySolver, so a peer cannot fill a peer's order.

const methods = new Map();

export function register(method) {
  for (const f of ["id", "parse", "describe"]) {
    if (!method?.[f]) throw new Error(`settlement method needs ${f}`);
  }
  methods.set(method.id, method);
  return method;
}

export const get = (id) => methods.get(id);
export const known = () => [...methods.keys()];

// CAIP-2 chain ids, so a leg can name any chain, not only EVM ones.
export const CHAINS = {
  base: "eip155:8453",
  bitcoin: "bip122:000000000019d6689c085ae165831e93",
  lightning: "lightning:bitcoin",
};
