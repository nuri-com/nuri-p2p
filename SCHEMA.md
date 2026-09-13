# The offer format

An offer is one JSON object. It carries everything a stranger needs to take it: no index, no API,
no lookup. Anyone can implement this; nothing here depends on us.

## Where offers live

Public Nostr relays, as event kind `38383`. We run none of them. The same object also works as a
file, a QR code, or a message — a relay is convenience, not a requirement.

## The event

```json
{
  "kind": 38383,
  "created_at": 1800000000,
  "content": "<the body below, JSON-encoded>",
  "tags": [
    ["d", "<order hash>"],
    ["k", "swap"],
    ["expiration", "<unix seconds>"],
    ["chain", "8453"],
    ["gives", "<token address>", "<amount in smallest units>"],
    ["wants", "<token address>", "<amount in smallest units>"],
    ["v", "nuri-p2p/1"]
  ]
}
```

Tags exist so a reader can filter without parsing the body. They are a hint; the body decides.
`d` makes the event replaceable, so updating an offer replaces it rather than duplicating it.
`expiration` follows NIP-40, so relays may drop stale offers on their own.

## The body

```json
{
  "v": "nuri-p2p/1",
  "chainId": 8453,
  "seaport": "0x0000000000000068F116a894984e2DB1123eB395",
  "order": { "...Seaport OrderComponents..." },
  "signature": "0x..."
}
```

`order` is a Seaport `OrderComponents` struct exactly as the maker signed it. `signature` is the
maker's EIP-712 signature over it, under domain
`{ name: "Seaport", version: "1.6", chainId: 8453, verifyingContract: <seaport> }`.

## What a reader must refuse

Refusing is cheap; being wrong costs money. Reject an offer that:

| Condition | Why |
|---|---|
| `v` is not a version you implement | it may mean something else |
| `chainId` is not the chain you are on | the signature is bound to a chain |
| `seaport` is not a settlement contract you trust | it decides where the tokens go |
| more than one offer item or consideration item | v1 is a straight two-sided swap |
| `zone` is not the zero address | a zone can interfere with the fill |
| `conduitKey` is not zero | a conduit moves the tokens somewhere else |
| `endTime` is in the past | expired |
| the signature does not recover to `order.offerer` | nobody else may spend the maker's tokens |

Then, before spending any gas, read the chain: the maker's balance and allowance, the order status,
and the maker's counter. Finally simulate the exact fill. All of this is free.

## What this format does not do

It does not reserve liquidity. A signed offer is a statement of willingness, not an escrow — the
maker can spend the money afterwards, and the fill then fails. It does not cross chains, and it does
not carry a price feed, a reputation, or a promise.
