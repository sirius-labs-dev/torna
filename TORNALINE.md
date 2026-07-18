# TornaLine — on-chain prediction markets, settled on TxLINE proofs

**Track:** Prediction Markets and Settlement (TxODDS World Cup Hackathon)
**Built on:** [Torna](./README.md) — a parallel, ordered, on-chain index primitive for Solana.

TornaLine turns Torna's reference order book (TornaDEX) into an **on-chain prediction market for live
World Cup football that settles trustlessly**. Outcome shares trade on a parallel central limit order
book with real SPL-token escrow; when a match finishes, anyone settles the market by making TxLINE's
`txoracle` verify a Merkle proof of the result **on-chain** — no trusted relayer, no admin key.

This is exactly the sponsor's own "Ideas to get started #4":
> *Build an order-book exchange that holds user funds (USDC) in escrow. When an event concludes, a
> user or keeper bot triggers your contract to CPI into TxLINE's validation program, trustlessly
> unlocking and routing funds to the winners.*

---

## Core idea

A market is one TxLINE fixture + one outcome (e.g. "home win"). It is a binary complete-set market:

- **YES** = the CLOB `base` mint · **NO** = a second mint · collateral = quote (USDC-like).
- `MINT_SET` deposits `payout` collateral per set and mints an equal **YES + NO** pair, so the quote
  vault always holds exactly enough to pay every winning share (solvent by construction).
- YES trades against quote on the **parallel CLOB** (Torna). Its price is the implied probability.
- `RESOLVE` settles the market by CPI into `txoracle.validate_stat_v3`, which verifies the Merkle
  multiproof against its own on-chain `daily_scores_roots` and returns whether the outcome holds.
- `REDEEM` burns winning-side shares for `payout` quote; losing shares are worth 0.

**The security property:** values come from the caller's proof; the *predicate* is fixed in the
market's `res` PDA at creation. The caller's proof leaves are bound to the market's stat legs, so a
settler can supply neither a false proof (the oracle rejects it) nor a self-serving predicate.

## Why Torna (the differentiator)

Live football markets have extreme write concurrency: a goal or card triggers a burst of order
placement/cancellation across many price levels at once. Single-account order books serialize and
choke exactly at those peak moments. Torna stores every B+ tree node in its own account, so
non-conflicting orders at different price levels settle **in parallel in the same slot**. The
settlement layer adds trustless, proof-verified resolution on top of that parallel book.

## Architecture

```
TxLINE (REST/SSE + txoracle program)        TornaLine (this repo)
────────────────────────────────────        ─────────────────────────────────
/fixtures, /odds, /scores  ───────────────►  relayer (demo/src/lib/txline) ──► UI + market-maker
/scores/stat-validation-v3 ───────────────►  borsh payload builder
txoracle.validate_stat_v3 (on-chain)  ◄────  RESOLVE CPIs it, reads the bool
daily_scores_roots PDA (published root) ◄──  RESOLVE binds the roots account to the proof's day
```

**On-chain — `orderbook/src/lib.rs`** (settlement layer added to the audited CLOB):
| Instruction | Role |
|---|---|
| `INIT_OUTCOME` | bind predicate (stat legs + comparison) + NO mint + payout + txoracle to a market |
| `MINT_SET` | deposit collateral → mint an equal YES + NO complete set |
| `RESOLVE` | CPI `validate_stat_v3(payload, strategy)`; stamp the winning side from the returned bool |
| `REDEEM` | burn winning shares → pay `payout` quote from the vault |

**Off-chain — `demo/`:**
- `src/lib/txline/` — REST client, config, SSE relay, auth model.
- `scripts/txline-activate.ts` — one-time guest JWT + on-chain subscribe + activation.
- `src/lib/orderbook.ts` — ix builders + the borsh `validate_stat_v3` payload builder.
- `scripts/bringup-prediction.ts` — stands up a settling market on devnet.
- `src/components/SettlementPanel.tsx` — live score strip + Mint / Resolve / Redeem.

## TxLINE surface used

**Off-chain REST / SSE**
- `POST /auth/guest/start` — guest JWT
- `POST /api/token/activate` — API token (after on-chain subscribe)
- `GET /api/fixtures/snapshot` — fixtures to open markets on
- `GET /api/odds/snapshot/{fixtureId}` + `GET /api/odds/stream` (SSE) — demargined odds → CLOB fair value
- `GET /api/scores/snapshot/{fixtureId}` + `GET /api/scores/stream` (SSE) — live score / events
- `GET /api/scores/stat-validation-v3` — the shared Merkle multiproof for settlement

**On-chain — txoracle `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` (devnet)**
- `subscribe` — free World Cup tier subscription (for token activation)
- `validate_stat_v3(payload, strategy)` — verifies the multiproof, evaluates the predicate, returns `bool`
- `daily_scores_roots` PDA `["daily_scores_roots", u16_le(epoch_day)]` — the published root

## Build & run

```bash
# on-chain
cd orderbook && cargo build-sbf

# app
cd demo && npm install
npx tsx scripts/txline-activate.ts >> .env.local   # provision TxLINE tokens (once)
FIXTURE_ID=<a finished fixture> npx tsx scripts/bringup-prediction.ts
npm run dev            # /trade → CLOB + the TornaLine settlement panel
```

## Status

- `cargo build` (orderbook) and `tsc` (demo) both clean.
- Settlement wire formats verified against `txoracle` IDL v1.5.6 and two independent community SDKs.
- See [`TXLINE_FEEDBACK.md`](./TXLINE_FEEDBACK.md) for our experience with the API.
