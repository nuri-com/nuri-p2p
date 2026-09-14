# contracts/ — where the EVM half of a Bitcoin swap locks funds

These files are **not written by us**. They are the exact source of
[`BoltzExchange/boltz-core`](https://github.com/BoltzExchange/boltz-core) at tag `v2.1.3`
(MIT license), copied verbatim:

| file | upstream | lines | what it does |
|---|---|---|---|
| `ERC20Swap.sol` | `contracts/ERC20Swap.sol` | 258 | locks ERC-20 behind `sha256(preimage)` + block-height timelock; claim with preimage, refund after timeout, cooperative refund via EIP-712 |
| `EtherSwap.sol` | `contracts/EtherSwap.sol` | 235 | same for native Ether |
| `TransferHelper.sol` | `contracts/TransferHelper.sol` | 49 | safe token/ether transfers |
| `TestERC20.sol` | `contracts/TestERC20.sol` | — | mintable test token, tests only, never deployed to mainnet |

Why this code: `sha256(preimage)` is the same hash a Bitcoin HTLC uses, so one secret unlocks
both sides. Block-height timelocks order cleanly against Bitcoin's CLTV heights.

Why our own deployment instead of Boltz's: we could not verify Boltz's Base deployment
addresses from here, and our deployment is one we can point at — immutable, no admin, source
verified on Basescan. Anyone can check address plus bytecode instead of trusting us.

What we changed: nothing in these four files. Our code lives in `test/` (forge tests),
`src/settle-htlc.mjs` (the protocol), and `scripts/` (the proofs). If upstream releases a fix,
we re-copy and re-verify.
