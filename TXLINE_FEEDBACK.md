# TxLINE API — feedback

Our honest experience building TornaLine's trustless settlement on TxLINE. Written for the
submission's "What was your team's experience using the TxLINE API?" prompt.

## What we liked most

- **The on-chain validation primitive is the killer feature.** `txoracle.validate_stat_v3` lets a
  program CPI in, verify a Merkle multiproof against TxLINE's own published root, and get back a
  `bool` for a predicate — all on-chain. This is what made *trustless* settlement possible: our
  contract trusts TxLINE's published root, not any relayer or our own off-chain code. Very few sports
  data providers expose anything like this.
- **The v3 shared multiproof is genuinely compact.** One multiproof over all legs instead of
  per-stat sibling paths keeps the settlement transaction small even as a market's legs grow.
- **Normalised JSON schema across competitions** made the odds/scores/fixtures client uniform — the
  same code path scales from one fixture to the whole tournament.
- **SSE streams** (`/odds/stream`, `/scores/stream`) with `Last-Event-ID` resume were the right shape
  for a live order book and a goal-triggered market-maker.
- **The `daily_scores_roots` PDA derivation is clean** (`["daily_scores_roots", u16_le(epoch_day)]`,
  epoch day from the proof's own timestamp), and the docs correctly warn that the day must come from
  the proof, not the wall clock — a subtle footgun called out well.

## Where we hit friction

- **The on-chain subscribe + activation flow is undocumented at the wire level.** The docs describe
  the *concept* (guest JWT → on-chain subscribe → activate) but not the `subscribe` instruction's
  discriminator/args/accounts, nor the exact activation message to sign. We had to reverse-engineer
  both from community SDKs (`@beriktassuly/txline`, `@h4rsharma/txline-settle`). Confirmed format,
  for the docs: message = `` `${txSig}:${leagues.join(",")}:${jwt}` ``, NaCl-detached, **base64**.
- **The `txoracle` IDL isn't linked from the docs.** The `validate_stat_v3` payload/strategy wire
  types, the coverage rule (each proven leg referenced exactly once — errors 6070/6071), and the
  `stat key = period*1000 + base` encoding are only discoverable via those community packages. A
  linked IDL + a minimal CPI example would have saved hours.
- **`format: binary` JSON fields are ambiguous.** The OpenAPI marks proof hashes as `format: binary`
  but doesn't state the JSON encoding; we assumed base64. A one-line note (base64 vs hex) would remove
  guesswork for anyone building the on-chain payload by hand.
- **Free-tier `serviceLevelId` / `weeks` for the World Cup aren't spelled out.** We defaulted to
  service level 1 / 4 weeks; a documented "this is the free World Cup tier" value would help.
- **Root-publication timing.** A freshly finalised match is provable by the REST API a few minutes
  before its root lands on-chain, so an early `RESOLVE` fails with a root-not-available error. The
  docs mention this; surfacing the expected batch cadence would make retry logic easier to tune.

## Suggestions (short)

1. Publish the `txoracle` IDL and a 20-line "CPI `validate_stat_v3` from your program" snippet.
2. Document the `subscribe` instruction + activation signing format in the quickstart.
3. State the JSON encoding of `format: binary` fields.
4. Name the free World Cup service level explicitly.

Overall: the validation primitive is excellent and exactly what a settlement layer needs — the main
gap is documentation of the on-chain surface, which today lives in community reverse-engineering.
