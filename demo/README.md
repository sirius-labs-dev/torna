# TornaFan — the live game for football fans

A provably-fair Higher/Lower game with a live on-chain leaderboard, built on the [Torna](../README.md)
engine. Entered in the TxODDS World Cup hackathon's **Consumer & Fan Experiences** track. The "phone in
your hand" moment, turned into a shared game — and **no admin can rig the board.**

**Live:** [tornafan.vercel.app](https://tornafan.vercel.app) · devnet · main route `/fan`

## What it is
While the match is live you tap **Higher** or **Lower** on what the next stat does (e.g. "will Spain's
goals go higher before the next update?"). Right calls extend your streak and push you up a leaderboard
the whole stadium is on; wrong calls reset it. Play as a guest — no wallet needed to try it.

## How it works
1. Pick a live match. Tap Higher/Lower — the pick is an on-chain transaction.
2. A keeper watches TxLINE. When the stat moves, `RESOLVE_ROUND` settles the round against a **TxLINE
   proof** (`validate_stat_v3`), then `SCORE_ONE` fans out **in parallel** to every player — different
   players are different leaves in the Torna tree, so the re-ranks commit in the same slot.
3. The leaderboard is read straight from the on-chain Torna tree and re-sorts every poll. Each round
   exposes a **"verify round N on-chain ↗"** receipt link.

The live game runs on the World Cup final and fills as it plays; a completed game (France v England) is
shown alongside — its final standings, scored on-chain against TxLINE proofs, verifiable right now.

## Why it's original
- **Provably fair:** scoring comes from TxLINE's on-chain, verifiable data — not a server we control.
  An admin can't decide who won a round.
- **Massively multiplayer, on-chain:** the leaderboard lives on-chain and re-ranks thousands of players
  in the same slot on a goal (Torna's parallelism) — no central database or indexer.
- The player never sees a line of crypto.

## Under the hood
- **Torna** — the parallel, ordered on-chain index (one B+ tree node per account) holds the leaderboard,
  so a goal re-ranks everyone in parallel in one slot.
- **TxLINE scoring** — each round is settled by a CPI into txoracle's `validate_stat_v3` (a Merkle proof
  of the stat).
- **orderbook program** `DHYpWACQxwuTqRHPFi6VMLWXY5xfWRaBUDfZK1Weob78` (devnet, carries the game
  instructions) · **Torna engine** `C2vPNBochYrcF4yCHDrtn9SPXUobsjrfPnZ2RPHUcAN5` · **txoracle**
  `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`.

## TxLINE endpoints used
`POST /auth/guest/start`, `POST /api/token/activate` (+ on-chain `subscribe`) · `GET /api/scores/snapshot/{id}`
(live state + the finalised update) · **`GET /api/scores/stat-validation-v3`** (the Merkle proof that
scores each round) · `GET /api/odds/snapshot/{id}` (optional difficulty hint).

## Run locally
```bash
npm install
npm run dev          # http://localhost:3000/fan
```
Bring-up + keeper scripts live in `scripts/` (`bringup-fan`, `fan-keeper`, `fan-live`); the UI reads
`src/lib/fan.json`.

Built on [Torna](../README.md) · scored on TxLINE proofs.
