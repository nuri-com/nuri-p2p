# nuri-p2p

Two people swap tokens on Base. Nobody in the middle.

One of them signs an offer. Their money stays in their own wallet. The other one executes it, and
both sides move in a single transaction — or nothing happens at all.

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
