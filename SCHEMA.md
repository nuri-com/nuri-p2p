# The intent format

An intent says **what**, not **how**. It is one JSON object that carries everything a stranger
needs: no index, no API, no lookup, no permission. Anyone can implement this.

```json
{
  "v": "nuri-p2p/2",
  "settle": "seaport-1.6",
  "by": "0x…",
  "id": "0x…",
  "give":  { "chain": "eip155:8453", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "amount": "1000000" },
  "want":  { "chain": "eip155:8453", "asset": "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", "amount": "920000" },
  "expiry": 1800003600,
  "terms":  { "…whatever the method needs…" },
  "proof":  "0x…"
}
```

`give` and `want` are what every reader can filter on, using CAIP-2 chain ids so a leg can be
Bitcoin, Lightning, an EVM chain, or something not invented yet. `settle` names the method.
`terms` and `proof` belong to that method and nobody else parses them.

## The one rule a method must satisfy

**Any taker can fill it.** No allowlist, no registration, no operator, no bond.

This is what separates this from a solver network. CoW Protocol has the better price and the
better auction, but its settlement contract is `onlySolver`: a peer cannot fill a peer's order,
and joining the solver set costs a pool plus onboarding. Same for NEAR Intents, which requires
approval plus KYC/KYB. Those are venues you send an order *to*. This is a board where peers
meet directly.

## Methods

| id | legs | atomic | status |
|---|---|---|---|
| `seaport-1.6` | ERC-20 ↔ ERC-20 on Base | yes, one transaction | works |
| `htlc-v1` | Bitcoin or Lightning ↔ EVM | two locks, one secret | readable, no adapter yet |

`htlc-v1` is registered and parsed but returns `no_adapter_yet`. That is deliberate: a method
that claims to be ready when it is not is worse than one that says so. Its timelock rule is
already enforced, because getting that wrong loses money:

```
takerRefundAt + 2h ≤ makerRefundAt
```

The taker locks second and must be able to refund **before** the maker can. Equal deadlines are a
race, not a swap.

## Adding a method

Write one file that registers `{ id, parse, describe }`. The board, the tests and the page do not
change. A client that does not know your method skips your intents; a client that does, fills them.

## What a reader must refuse

Refusing is free; being wrong costs money.

| Condition | Why |
|---|---|
| `v` you do not implement | it may mean something else entirely |
| `settle` you do not know | never guess at settlement |
| expired | nothing to do |
| `id` disagrees with `terms` | the id is how the chain identifies it |
| `give`/`want` disagree with `terms` | the advertised deal is not the real one |
| `proof` does not belong to `by` | nobody else may spend the maker's money |

For `seaport-1.6` additionally: a non-zero `zone` or `conduitKey` could interfere with the fill,
and more than one item per side is not a straight two-sided swap.

Then read the chain — balance, allowance, order status, the maker's counter — and simulate the
exact fill. All of it free, all of it before any gas.

## What this format does not do

It does not reserve liquidity: a signed intent is willingness, not escrow, and the maker can spend
the money afterwards. It carries no price feed, no reputation, and no promise that anyone will take
it. An empty board is a normal state.
