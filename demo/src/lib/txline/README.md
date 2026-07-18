# TxLINE relayer (server-side)

Bridges the TxLINE off-chain feed into the Torna prediction market. Tokens live only on the
server; the browser talks to our own routes, never to TxLINE.

## Auth (provision once)

```
npm i -D tsx bs58 tweetnacl @coral-xyz/anchor
cp .env.txline.example .env.local        # then fill RELAYER_SECRET
npx tsx scripts/txline-activate.ts >> .env.local   # appends TXLINE_GUEST_JWT / TXLINE_API_TOKEN
```

Flow: `POST /auth/guest/start` (Bearer JWT) → on-chain `subscribe` (program
`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`, devnet) → sign → `POST /api/token/activate`
(`leagues: []` = free/standard tier, fee-waived for the World Cup). Every data call then sends
`Authorization: Bearer <JWT>` + `X-Api-Token: <token>`.

> Two spots in `scripts/txline-activate.ts` (`buildSubscribeIx`, `activationMessage`) need the exact
> instruction + signing format from TxLINE's own devnet example (`idl/txoracle.json`,
> `common/users.ts`). Program ID and the empty-leagues tier are confirmed; those two are the only
> unknowns and are isolated so nothing else is blocked.

## Runtime files

| File | Purpose |
|---|---|
| `config.ts` | env + host/URL derivation |
| `client.ts` | REST: `fixtures`, `oddsSnapshot`, `scoresSnapshot`, `statValidation`, `pctToPrice`, JWT refresh |
| `streams.ts` | server SSE consumer (odds/scores) with `Last-Event-ID` resume |
| `useTxlineStream.ts` | browser hook onto the SSE relay |

## Routes (browser-facing)

| Route | Backs |
|---|---|
| `GET /api/txline/fixtures?epochDay=&competitionId=` | market creation (fixture picker → `INIT_MARKET`) |
| `GET /api/txline/odds/{fixtureId}` | fair value; each outcome carries `fairPrice` in USDC/share for the maker |
| `GET /api/txline/scores/{fixtureId}?proof=1` | live score; `?proof=1` adds the stat-validation Merkle proof for `RESOLVE` |
| `GET /api/txline/stream?type=odds\|scores&fixtureId=` | SSE relay (live ticker + goal/card triggers) |

## How it plugs into the market

- **odds `Pct[]` → `pctToPrice` → CLOB limit price** → maker `PLACE`/`MATCH` (existing `actions.ts`).
- **scores stream** → live UI + "match finished" → fetch `?proof=1` → on-chain `RESOLVE` (new ix)
  verifies the proof against `daily_scores_roots` PDA → `REDEEM` (new ix) pays the winning shares.

The proof path is what makes settlement trustless: the chain trusts TxLINE's published root, not
this relayer.
