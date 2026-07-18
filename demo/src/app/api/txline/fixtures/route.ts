// GET /api/txline/fixtures?epochDay=&competitionId=
// Proxied fixture list (server holds the TxLINE tokens). The UI picks a fixture from here, then
// bringup opens a market per outcome. Cached briefly — fixtures barely change intraday.
import { NextRequest, NextResponse } from "next/server";
import { fixtures } from "@/lib/txline/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TxLINE epochDay = days since Unix epoch (UTC). Default to "today" so the demo shows live games.
const todayEpochDay = () => Math.floor(Date.now() / 86_400_000);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const epochDay = Number(sp.get("epochDay") ?? todayEpochDay());
  const competitionId = sp.get("competitionId") ? Number(sp.get("competitionId")) : undefined;
  try {
    const rows = await fixtures(epochDay, competitionId);
    return NextResponse.json({ fixtures: rows }, { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
