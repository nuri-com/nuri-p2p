# Working on this

## Before you push

```sh
npm run check      # every file parses
npm test           # 39 tests, 8 of them read Base for real
npm run test:page  # boots index.html in headless Chrome
```

All three must exit 0.

## The rules

1. **`npm test` can never spend money.** It holds no key and sends no transaction. If a change makes
   the test suite capable of spending, the change is wrong.
2. **A guard needs a test that fails when the guard is removed.** Delete the line, run the suite, see
   it go red, put the line back, see it go green. A test that passes either way protects nothing.
3. **Anything the chain decides, ask the chain.** Our order hash is asserted against Seaport's own
   `getOrderHash`, not against a value we wrote down. That test has already caught one real bug.
4. **A refusal is a sentence, not a code.** Every reason a swap cannot happen is written the way you
   would say it to a person: "Whoever made this offer no longer has the money." No error codes, no
   jargon, in the page.
5. **Never call something atomic unless the contract enforces it.** Here it is true because Seaport
   moves both sides in one transaction. Do not reuse the word for anything weaker.
6. **Real money proves a route, nothing else does.** A route counts as working when
   `npm run prove -- --execute` has produced a proof file with a transaction hash in it. Only the
   owner runs that, and only with small amounts.

## Layout

```
src/constants.mjs  addresses and values we depend on, all verified on chain
src/offer.mjs      build, sign and verify an offer
src/board.mjs      publish and read offers over Nostr, or as a file
src/fill.mjs       check, simulate and execute a fill
index.html         the whole product for a person, one file
scripts/prove.mjs        one real swap, end to end, writes a proof
scripts/prove-stale.mjs  the evil twin: proves a dead offer costs the taker nothing
```
