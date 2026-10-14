# Changelog

Newest first. Every bullet names the commit it comes from.

## 2026-10-14 — [RELEASE] v0.1.0 — hermes-agent for emino

First tagged release. State of `main` at `98408a34`:

- `seaport-1.6` settlement works: peer-to-peer ERC-20 swaps on Base, one Seaport 1.6 transaction, proven on mainnet (`proofs/fill-30cd40bdde.json`).
- Intents are published to and read back from public Nostr relays (kind 38383), or exchanged as a file.
- `index.html` is the single-file frontend: make, check and fill offers from `file://` with a browser wallet.
- `htlc-v1` is parsed with timelock safety enforced, but returns `no_adapter_yet`.
- Bitcoin HTLC lock, claim and refund proven on signet. The Boltz v2.1.3 `ERC20Swap` contract is vendored with 9 forge tests.
- 67 node tests, read-only against Base. Nothing spends money without `--execute`.
- Docs: README restructured (Logs, Status, Architecture, User flow, Components, API, Run), CHANGELOG and PROMPTLOG added. No code changed.

## 2026-09-16

- `98408a34` Proof JSON files are now tracked and published; the foundry build cache is ignored.
- `b1a0b090` Repo hygiene: foundry `cache/` removed from git, `.gitmodules` fixed so forge-std and openzeppelin-contracts are real submodules and a fresh clone builds.

## 2026-09-15

- `26931611` Bitcoin signet proof: lock, claim with the secret, refund after timeout, via `scripts/prove-btc.mjs`.
- `53f45375` HTLC timelocks are compared in wall-clock seconds, not raw block heights, so chains with different block times are ordered safely.
- `7736d497` Bitcoin HTLC script, claim and refund spends, and an Esplora client in `src/btc.mjs`, with 21 tests.
- `7cce82b4` Vendored Boltz v2.1.3 HTLC contracts under `contracts/`, plus 9 forge tests.
- `58712f5b` README: live demo offer section.

## 2026-09-13

- `7789f8c8` README with Mermaid charts, live proof table and layout map.
- `7337d2fa` Live proof: a peer-to-peer USDC to EURC swap settled by Seaport on Base mainnet.
- `031207c6` Board proven live on public Nostr relays.
- `4dc0ea39` Intents carry a `settle` method name, so a new settlement rail needs no change to the board.
- `42fc921f` First commit: peer-to-peer swaps on Base, settled by Seaport 1.6.
