# MintGuard — a wallet & transaction screening agent

MintGuard screens a BNB Smart Chain (BSC) mint or claim contract **before**
anyone signs anything. Give it a contract address and it returns a verdict
built from public, read-only evidence: whether code exists at the address,
whether the source is verified on Sourcify, and what basic on-chain probes
report. It never connects a wallet, never signs, and never sends a
transaction.

This demo service is the public face of a screening workflow that is already
used in practice to vet free-mint and claim links for an agentic wallet:
check first, verify on-chain, and only then let a human decide.

## The problem

Users of agentic wallets are constantly sent mint and claim links — in
chats, on social media, by other agents. The dangerous moment is the
signature: one click on a malicious or simply misdescribed contract can
drain a wallet, buy something that was advertised as free, or chase a pool
that is already empty. Project websites are not a reliable source of truth:
their counters can be stale, their "free" tier can be exhausted, and their
displayed contract address can differ from the one that matters.

What a user needs at that moment is a cheap, safe, independent check that
answers: *what is this contract, really — and is the opportunity it claims
to offer still there?*

## Who it helps

- **Agentic-wallet users** who receive mint/claim links and must decide
  whether a signature is safe and worthwhile.
- **Agents acting for those users**, which need machine-readable verdicts
  (JSON) instead of marketing copy.
- **Anyone triaging a link quickly**: the screen costs nothing, risks
  nothing, and takes seconds.

## How it works

1. **Input.** `POST /check` with `{"contract": "0x…"}` (or
   `GET /check?contract=0x…`).
2. **Validate.** The address must be `0x` + 40 hex characters; anything
   else is rejected with a 400. Fail-closed, always.
3. **Probe the chain.** `eth_getCode` via a public BSC RPC
   (`bsc-dataseed.bnbchain.org`, falling back to
   `bsc-rpc.publicnode.com`) confirms a contract actually exists there.
4. **Check verification.** Sourcify's API reports whether the deployed
   source for chain 56 is verified — i.e. whether the code about to be
   trusted can actually be read and audited.
5. **Run safe probes.** Read-only `eth_call`s such as `totalSupply()`
   (selector `0x18160ddd`). A revert simply marks that probe unavailable —
   a sale contract that exposes no `totalSupply()` is normal, not an error.
6. **Verdict.** The response combines the signals into JSON plus a
   one-line human summary, e.g. *"Contract is live on-chain and
   Sourcify-verified … still run the full supply/quota/price probes before
   signing"* or *"NOT Sourcify-verified — treat as high risk."*

Every network call has an 8-second timeout, every probe fails soft, and
the endpoint never crashes on bad input.

### Endpoints

| Route | Description |
|---|---|
| `GET /` | Human-readable info page with real example verdicts and a try-it form. |
| `GET /health` | `{"ok": true}` liveness check. |
| `POST /check` | JSON body `{"contract": "0x…"}` → JSON verdict. |
| `GET /check?contract=0x…` | Same verdict via query string. |

Example verdict (fields abbreviated):

```json
{
  "contract": "0xb9d0CA9b63C564443AfE64B77ef91B3bA763e5f1",
  "chain": "bsc",
  "hasCode": true,
  "sourcify": "verified",
  "probes": { "totalSupply": null },
  "summary": "Contract is live on-chain and Sourcify-verified, so its source is public — still run the full supply/quota/price probes before signing."
}
```

## Key design decisions

- **Read-only by design.** The service holds no keys, has no wallet code
  and cannot sign or transact. Screening is separated from execution, so
  the thing that judges a contract can never be the thing that loses money
  to it.
- **Contract reads over site claims.** Websites are treated as untrusted
  input. Supply, quotas, prices and phase are believed only when read from
  the chain or a verification registry — a lesson learned from real sales
  whose pages showed "free shares remaining" after the pool had sold out.
- **Fail-closed.** Malformed input is rejected; unreachable data is
  reported as `unknown`, never guessed as safe. "We could not check" is a
  valid and important verdict.
- **Verified ≠ opportune.** A verified contract can still be a bad idea
  (pool drained, price moved). The summary says what the signals do and do
  not establish, instead of stamping a naive "safe".
- **Zero dependencies.** Node.js standard library only (`node:http`,
  global `fetch`). Nothing to install, nothing in the supply chain to
  trust, trivial to audit end-to-end — this file's server is ~370 lines.

## Real screens behind the examples on the info page

- **FEG CanopySale** (`0xb9d0CA9b63C564443AfE64B77ef91B3bA763e5f1`) —
  Sourcify-verified; probes confirmed a live free-share pool. A free share
  was claimed at the opening and the booking verified on-chain.
- **DYOR DyorNFT** (`0x86956Bc830EB62110820Ae79164BeF61c7E31936`) —
  Sourcify-verified; probes showed the first mint per agent identity is
  free and the rest paid. Exactly one free mint was taken.
- **Broccoli Agent** (`0xc438821D5937E5246a50f877311a74e40f82eB87`) —
  Sourcify-verified, but the 500-lot free pool drained in ~90 seconds.
  Verdict: skip. Verification tells you what a contract *is*; only live
  probes tell you whether the opportunity still exists.

## Run it

```bash
node server.js            # listens on $PORT, default 8787
curl localhost:8787/health
curl -X POST localhost:8787/check \
  -H 'content-type: application/json' \
  -d '{"contract":"0xb9d0CA9b63C564443AfE64B77ef91B3bA763e5f1"}'
```

Requires Node.js 22+ (developed on v24). No `npm install` — there are no
dependencies.

## Limits

- This demo probes BSC only, and only a starter set of getters
  (`totalSupply()`); the production workflow adds per-contract supply,
  quota, price and phase getters chosen from the verified ABI.
- Sourcify status is a strong signal, not a guarantee: verified source
  still has to be read, and unverified contracts are flagged, not
  convicted.
- The screen is a snapshot. Pools drain and phases flip in seconds; a
  verdict is a basis for a decision, not a substitute for re-checking at
  signing time.
- It deliberately does **not** do the signing step. A human (or their
  agent, under the human's rules) always makes the final call.
