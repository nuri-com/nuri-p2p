# nuri-p2p

A board where peers post intents and other peers fill them. Nobody in the middle.

An intent says what you give and what you want. `settle` names how it settles. Anyone who
understands that method can fill it — no allowlist, no registration, no operator. Today one method
works (two ERC-20 legs on Base, both moved in a single transaction). Bitcoin is the next one, and
adding it does not change the board, the page, or anybody else's client.

## Why not just use CoW

CoW has the better price and the better auction. But its settlement contract is `onlySolver`: a
peer cannot fill a peer's order, and joining the solver set means a pool plus onboarding. NEAR
Intents needs approval and KYC/KYB. Those are venues you send an order *to*.

This is the other thing: peers meeting directly, any taker, no permission. If you want the best
price on an EVM pair, use CoW. If you want two people — or two agents — to trade without asking
anyone, use this.

## What this is not

No contract of ours. No server. No account. No database. No fee. No operator.

Settlement is [Seaport 1.6](https://github.com/ProjectOpenSea/seaport), already deployed and
audited on Base at `0x0000000000000068F116a894984e2DB1123eB395`. Offers travel over public Nostr
relays that other people run. If this project disappears tomorrow, every signed offer still works.

## Why there is no recovery key

Because nothing is ever held. An offer is a signed piece of text, not a transfer. Until someone
executes it, the money has not moved. If nobody executes it, the offer expires and that is the end
of it.

## Honest limits

- An offer is not a promise. The maker can spend the money afterwards; the fill then simply fails.
  Check before you send — it costs you nothing.
- A fixed-price offer is a free option for whoever takes it, until it expires. Keep expiries short.
- No offers means no offers. An empty board is a normal state.
- USDC and EURC are issued by Circle, who can freeze them. What we promise is a swap that needs no
  trust in **us** — not money that nobody controls.
- Same chain only. Bitcoin, Lightning and Arkade need someone to be online at the right moment,
  which is a different promise. Not here.

## Run it

```sh
npm install
npm test
```

Open `index.html` in a browser. It works from `file://`, with no server.
