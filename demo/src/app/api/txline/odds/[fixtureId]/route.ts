// GET /api/txline/odds/{fixtureId}
// Latest demargined odds for a fixture. Returns each outcome with its fair-value CLOB price
// (Pct -> USDC/share), i.e. exactly the limit price the maker should quote around.
import { NextRequest, NextResponse } from "next/server";
import { oddsSnapshot, pctToPrice } from "@/lib/txline/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await ctx.params;
  try {
    const o = await oddsSnapshot(Number(fixtureId));
    const outcomes = o.PriceNames.map((name, i) => ({
      name, // "1" | "X" | "2" | "Over" | "Under" ...
      decimalOdds: o.Prices[i] ?? null,
      prob: typeof o.Pct[i] === "number" ? (o.Pct[i] as number) : null,
      fairPrice: pctToPrice(o.Pct[i])?.toString() ?? null, // quote units (USDC, 6dp)
    }));
    return NextResponse.json(
      { fixtureId: o.FixtureId, market: o.SuperOddsType, line: o.MarketParameters, inRunning: o.InRunning, ts: o.Ts, outcomes },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
