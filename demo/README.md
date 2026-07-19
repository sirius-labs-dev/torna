# TornaLine — prediction market + trustless settlement

An on-chain prediction market on live World Cup football, built on the [Torna](../README.md) engine.
Entered in the TxODDS World Cup hackathon's **Prediction Markets & Settlement** track. One
trust-minimized core: **the result is decided by an on-chain proof of TxLINE's data, never by an admin.**

**Live:** [tornaline.vercel.app](https://tornaline.vercel.app) · devnet · main route `/trade`

## What it is
You trade **outcome shares** (e.g. "Spain to win") on a real central limit order book; the price is the
implied probability. When the match ends, **anyone** can settle the market — no admin, no oracle you
have to trust.

## How settlement works (the point of the whole thing)
1. A market is a complete set: minting 1 quote returns an equal YES + NO pair; a YES share pays 1 if the
   outcome happens, 0 if not.
2. Trading happens on Torna's parallel order book (`/trade`): place / take / cancel are live devnet txs,
   read from the on-chain B+ tree, price = implied probability.
3. At full time, `RESOLVE` runs a **CPI into TxLINE's txoracle** (`validate_stat_v3`), which verifies a
   **Merkle multiproof** of the final score against the on-chain `daily_scores_roots`. The outcome comes
   from the proof, not from whoever clicked resolve.
4. Winners `REDEEM` their shares for the collateral. The `/trade` page shows a **verifiable settlement
   receipt** with links to the resolve transaction, the resolution account, and the txoracle program —
   anyone can re-check it on-chain.

The live market trades the World Cup final (settles at full time); a completed market (France v England)
is shown alongside, already settled on-chain, so the settlement mechanism is verifiable right now.

## Why it's original
Most sports markets are settled by a server that reports the result. TornaLine's result is a
cryptographic proof verified on-chain — an admin cannot decide who won — and the order book is a real
parallel CLOB, not a database.

## Under the hood
- **Torna** — the parallel, ordered on-chain index (one B+ tree node per account) holds the ask/bid order
  books, so matches and cancels commit in parallel in the same slot.
- **TxLINE settlement** — a CPI into txoracle's `validate_stat_v3` verifies a Merkle proof of the score.
- **orderbook program** `DHYpWACQxwuTqRHPFi6VMLWXY5xfWRaBUDfZK1Weob78` (devnet) · **Torna engine**
  `C2vPNBochYrcF4yCHDrtn9SPXUobsjrfPnZ2RPHUcAN5` · **txoracle** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.

## TxLINE endpoints used
`POST /auth/guest/start`, `POST /api/token/activate` (+ on-chain `subscribe`) · `GET /api/fixtures/snapshot`
· `GET /api/scores/snapshot/{id}` (live state + the finalised update) · **`GET /api/scores/stat-validation-v3`**
(the Merkle proof that settles the market) · `GET /api/odds/snapshot/{id}` (implied-probability hint).

## Run locally
```bash
npm install
npm run dev          # http://localhost:3000/trade
```
Bring-up scripts live in `scripts/` (`bringup-prediction`); the UI reads `src/lib/market.json`.

Built on [Torna](../README.md) · settled on TxLINE proofs.
