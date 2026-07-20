// TxLINE REST client (server-only). Thin, typed wrappers over the documented endpoints the
// prediction market needs: fixtures (market creation), odds (fair value), scores (live UI +
// settlement input), and stat-validation (the Merkle proof that makes settlement trustless).
//
// Endpoints & response fields are taken from the TxLINE OpenAPI (docs.yaml). Field names mirror
// the wire format (PascalCase for fixtures/odds, camelCase for scores) — kept as-is so a juror can
// diff our code against the schema.

import { txlineConfig, apiUrl, authUrl, type TxlineConfig } from "./config";

// ---- guest JWT refresh (JWT is 30-day; a 401 mid-hackathon means it lapsed) ----

let cachedJwt: string | undefined;

/** POST /auth/guest/start -> { token }. Refreshes the Bearer JWT without re-subscribing. */
export async function refreshGuestJwt(cfg: TxlineConfig): Promise<string> {
  const res = await fetch(authUrl(cfg.host, "/auth/guest/start"), { method: "POST" });
  if (!res.ok) throw new Error(`guest/start failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  cachedJwt = token;
  return token;
}

function headers(cfg: TxlineConfig, jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}`, "X-Api-Token": cfg.apiToken };
}

/** GET a data endpoint with both auth headers; transparently refreshes the JWT once on 401. */
async function get<T>(path: string): Promise<T> {
  const cfg = txlineConfig();
  const jwt = cachedJwt || cfg.guestJwt;
  let res = await fetch(apiUrl(cfg.host, path), { headers: headers(cfg, jwt), cache: "no-store" });
  if (res.status === 401) {
    const fresh = await refreshGuestJwt(cfg);
    res = await fetch(apiUrl(cfg.host, path), { headers: headers(cfg, fresh), cache: "no-store" });
  }
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

// ---- typed shapes (subset of docs.yaml we actually consume) ----

export interface Fixture {
  FixtureId: number;
  StartTime: string;
  Competition: string;
  Participant1: string;
  Participant2: string;
  Participant1IsHome: boolean;
}

export interface OddsSnapshot {
  FixtureId: number;
  MessageId: number;
  Ts: string;
  Bookmaker: string;
  SuperOddsType: string; // market type, e.g. "1X2", "OVER_UNDER"
  InRunning: boolean; // live (in-play) vs pre-match
  MarketParameters?: string; // e.g. the O/U line "2.5"
  MarketPeriod?: string;
  PriceNames: string[]; // e.g. ["1","X","2"] or ["Over","Under"]
  Prices: (number | null)[]; // decimal odds
  Pct: (number | string)[]; // DEMARGINED probability 0..1 (3dp) or "NA" -> our fair-value price
}

export interface ScoresSnapshot {
  fixtureId: number;
  gameState: string; // e.g. "IN_PLAY","FINISHED"
  action: string; // last event: "GOAL","RED_CARD",...
  ts: string;
  seq: number; // monotonic; used as the settlement anchor + stat-validation param
  scoreSoccer?: { p1: number; p2: number };
  dataSoccer?: unknown;
}

// Raw stat-validation-v3 multiproof (shape consumed by buildValidateStatPayload on the client).
export interface StatValidationV3 {
  ts?: number;
  summary: { fixtureId: number; updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number }; eventStatsSubTreeRoot: string };
  subTreeProof?: { hash: string | number[]; isRightSibling: boolean }[];
  mainTreeProof?: { hash: string | number[]; isRightSibling: boolean }[];
  eventStatRoot: string;
  statsToProve: { stat: { key: number; value: number; period: number }; statProof?: { hash: string | number[]; isRightSibling: boolean }[] }[];
  multiproof: { hashes?: { hash: string | number[]; isRightSibling: boolean }[]; indices: number[] };
}

// One row of the scores snapshot (used to find the finalised update).
interface ScoreRow { StatusId?: number; Seq?: number }

// ---- market creation ----

/** GET /api/fixtures/snapshot?startEpochDay=&competitionId= — the fixtures to open markets on. */
export function fixtures(startEpochDay: number, competitionId?: number): Promise<Fixture[]> {
  const q = new URLSearchParams({ startEpochDay: String(startEpochDay) });
  if (competitionId != null) q.set("competitionId", String(competitionId));
  return get<Fixture[]>(`/fixtures/snapshot?${q}`);
}

// ---- fair value (odds) ----

/** GET /api/odds/snapshot/{fixtureId} — latest demargined odds; Pct[] feeds the maker's price. */
export function oddsSnapshot(fixtureId: number, asOf?: string): Promise<OddsSnapshot> {
  const q = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return get<OddsSnapshot>(`/odds/snapshot/${fixtureId}${q}`);
}

// ---- live scores / settlement input ----

/** GET /api/scores/snapshot/{fixtureId} — latest score/state; the final one drives RESOLVE. */
export function scoresSnapshot(fixtureId: number, asOf?: string): Promise<ScoresSnapshot> {
  const q = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return get<ScoresSnapshot>(`/scores/snapshot/${fixtureId}${q}`);
}

/** GET /api/scores/snapshot/{fixtureId} as rows — used to find the finalised update's seq. */
export function scoresRows(fixtureId: number): Promise<ScoreRow[]> {
  return get<ScoreRow[]>(`/scores/snapshot/${fixtureId}`);
}

/** The finalised sequence number for a fixture (StatusId 100 = game_finalised), else the max seq. */
export async function findFinalisedSeq(fixtureId: number): Promise<{ seq: number; finalised: boolean }> {
  const rows = await scoresRows(fixtureId);
  if (!rows.length) throw new Error(`no score records for fixture ${fixtureId} (results age out ~23 days)`);
  const fin = rows.filter((r) => r.StatusId === 100);
  const src = fin.length ? fin : rows;
  return { seq: src.reduce((mx, r) => Math.max(mx, r.Seq ?? 0), 0), finalised: fin.length > 0 };
}

/**
 * GET /api/scores/stat-validation-v3 — the shared Merkle multiproof for `statKeys`. Raw shape;
 * the client turns it into the borsh validate_stat_v3 payload. `statKeys` order == leg order.
 */
export function statValidationV3(fixtureId: number, seq: number, statKeys: number[]): Promise<StatValidationV3> {
  const q = new URLSearchParams({ fixtureId: String(fixtureId), seq: String(seq), statKeys: statKeys.join(",") });
  return get<StatValidationV3>(`/scores/stat-validation-v3?${q}`);
}

/** Convert a demargined-probability outcome to a CLOB limit price in quote units (USDC, 6dp). */
export function pctToPrice(pct: number | string, decimals = 6): bigint | null {
  if (pct === "NA" || typeof pct !== "number") return null;
  return BigInt(Math.round(pct * 10 ** decimals)); // 0.734 prob -> 734000 (0.734 USDC / share)
}
