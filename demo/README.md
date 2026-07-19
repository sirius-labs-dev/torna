# TornaLine & TornaFan

Two live products on the [Torna](../README.md) engine, entered in two TxODDS World Cup hackathon
tracks. One Next.js app serves both — host-based routing sends `tornaline.vercel.app` to the market
and `tornafan.vercel.app` to the game. They share one trust-minimized core: **the result is decided by
an on-chain proof of TxLINE's data, never by an admin.**

| | **TornaLine** | **TornaFan** |
|---|---|---|
| Track | Prediction Markets & Settlement | Consumer & Fan Experiences |
| One-liner | Trade a match outcome, settle it trustlessly | One-tap Higher/Lower, climb a live on-chain board |
| Live | [tornaline.vercel.app](https://tornaline.vercel.app) | [tornafan.vercel.app](https://tornafan.vercel.app) |
| Main route | `/trade` | `/fan` |

---

## TornaLine — prediction market + trustless settlement

An on-chain prediction market on live World Cup football. You trade **outcome shares** (e.g. "France to
win") on a real central limit order book; the price is the implied probability. When the match ends,
**anyone** can settle the market — no admin, no oracle you have to trust.

**How settlement works (the point of the whole thing):**
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

**Why it's original:** most sports markets are settled by a server that reports the result. TornaLine's
result is a cryptographic proof verified on-chain — an admin cannot decide who won, and the order book
is a real parallel CLOB, not a database.

**Key routes:** `/trade` (market + order book + settlement), `/explorer` (Torna-aware account explorer).

## TornaFan — fan game + live on-chain leaderboard

The "phone in your hand" moment, turned into a shared game. While the match is live you tap **Higher**
or **Lower** on what the next stat does (e.g. "will France's goals go higher before the next update?").
Right calls extend your streak and push you up a leaderboard the whole stadium is on; wrong calls reset
it.

**How it works:**
1. Play as a guest (demo players) — no wallet needed to try it. Tap Higher/Lower; the pick is an on-chain
   transaction.
2. A keeper watches TxLINE. When the stat moves, `RESOLVE_ROUND` settles the round against a **TxLINE
   proof** (same `validate_stat_v3` path as TornaLine), then `SCORE_ONE` fans out **in parallel** to
   every player — different players are different leaves in the Torna tree, so the re-ranks commit in the
   same slot.
3. The leaderboard is read straight from the on-chain Torna tree and re-sorts every poll. Each round
   exposes a **"verify round N on-chain ↗"** receipt link.

**Why it's original:** provably fair (no admin can rig the board) and massively multiplayer on-chain
(the leaderboard is on-chain and re-ranks thousands in one slot on a goal) — without the player ever
seeing a line of crypto.

**Key route:** `/fan` (the game + live leaderboard). On `tornafan.vercel.app` the middleware rewrites
`/` → `/fan` and the nav/footer rebrand to TornaFan.

---

## Shared foundation

- **Torna** — the parallel, ordered on-chain index (one B+ tree node per account). It holds TornaLine's
  order book (ask/bid trees) and TornaFan's leaderboard; parallelism is what lets re-ranks and matches
  commit in the same slot.
- **TxLINE settlement** — both products settle from a TxLINE Merkle proof verified on-chain via a CPI
  into txoracle's `validate_stat_v3`. This is the shared trust-minimized core.
- **orderbook program** — one Solana program carries the market instructions (PLACE/RESOLVE/REDEEM/…)
  and the game instructions (INIT_GAME/PLACE_PICK/RESOLVE_ROUND/SCORE_ONE/…).

### On-chain artifacts (devnet)
| | |
|---|---|
| Torna engine | `C2vPNBochYrcF4yCHDrtn9SPXUobsjrfPnZ2RPHUcAN5` |
| orderbook (market + game) | `DHYpWACQxwuTqRHPFi6VMLWXY5xfWRaBUDfZK1Weob78` |
| TxLINE txoracle | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |

### TxLINE endpoints used
`POST /auth/guest/start`, `POST /api/token/activate` (+ on-chain `subscribe`) · `GET /api/scores/snapshot/{id}`
(live state + the finalised update) · `GET /api/scores/stat-validation-v3` (the Merkle proof that settles a
market/round) · `GET /api/odds/snapshot/{id}` (implied-probability hint) · `GET /api/fixtures/snapshot`.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000  (/trade = TornaLine, /fan = TornaFan)
```

Bring-up + keeper scripts live in `scripts/` (`bringup-prediction`, `bringup-fan`, `fan-keeper`); the UI
reads `src/lib/market.json` and `src/lib/fan.json`.

Built on [Torna](../README.md) · settled on TxLINE proofs.
