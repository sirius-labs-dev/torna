// GET /api/txline/odds/{fixtureId}
// Latest demargined odds for a fixture. The snapshot is an array of market rows; we pick the 1X2
// participant-result market and return each outcome with its implied probability (a 0–1 fraction) and
// fair-value CLOB price. Feeds the "TxLINE consensus" number on the market card.
import { NextRequest, NextResponse } from "next/server";
import { oddsSnapshot, pctToPrice } from "@/lib/txline/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type OddsRow = {
  SuperOddsType?: string; PriceNames?: string[]; Prices?: (number | null)[];
  Pct?: (string | number)[]; FixtureId?: number; MarketParameters?: string;
  InRunning?: boolean; Ts?: number;
};
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "NA" ? parseFloat(v) : NaN);

export async function GET(_req: NextRequest, ctx: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await ctx.params;
  try {
    const raw = (await oddsSnapshot(Number(fixtureId))) as unknown as OddsRow | OddsRow[];
    const arr = Array.isArray(raw) ? raw : [raw];
    // the 1X2 result market with a real percentage, else any row with price names
    const o =
      arr.find((r) => r.SuperOddsType === "1X2_PARTICIPANT_RESULT" && Array.isArray(r.PriceNames) && r.Pct?.[0] !== "NA") ??
      arr.find((r) => Array.isArray(r.PriceNames));
    if (!o?.PriceNames) {
      // no live 1X2 odds (pre-match/finished) — return empty so the card shows "— closed", not an error
      return NextResponse.json({ fixtureId: Number(fixtureId), outcomes: [] }, { headers: { "cache-control": "no-store" } });
    }
    const outcomes = o.PriceNames.map((name, i) => {
      const pct = num(o.Pct?.[i]);
      return {
        name, // "part1" (home) | "draw" | "part2" (away)
        decimalOdds: o.Prices?.[i] ?? null,
        prob: Number.isFinite(pct) ? pct / 100 : null, // 0–1 fraction
        fairPrice: pctToPrice(o.Pct?.[i] as number | string)?.toString() ?? null,
      };
    });
    return NextResponse.json(
      { fixtureId: o.FixtureId, market: o.SuperOddsType, line: o.MarketParameters, inRunning: o.InRunning, ts: o.Ts, outcomes },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
