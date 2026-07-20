// GET /api/txline/scores/{fixtureId}                      -> live score/state
// GET /api/txline/scores/{fixtureId}?proof=1&statKeys=1,2 -> finalised seq + raw v3 multiproof
//
// The proof payload is what the on-chain RESOLVE feeds to txoracle's validate_stat_v3. statKeys
// order must equal the market's predicate leg order (e.g. home win / over-goals -> "1,2").
import { NextRequest, NextResponse } from "next/server";
import { scoresSnapshot, findFinalisedSeq, statValidationV3 } from "@/lib/txline/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await ctx.params;
  const fid = Number(fixtureId);
  const sp = req.nextUrl.searchParams;
  const withProof = sp.get("proof") === "1";
  try {
    if (!withProof) {
      const s = await scoresSnapshot(fid);
      return NextResponse.json({
        fixtureId: s.fixtureId, gameState: s.gameState, lastEvent: s.action, seq: s.seq, ts: s.ts,
        score: s.scoreSoccer ?? null, finished: s.gameState === "FINISHED",
      }, { headers: { "cache-control": "no-store" } });
    }
    const statKeys = (sp.get("statKeys") ?? "1,2").split(",").map(Number).filter((n) => !Number.isNaN(n));
    const { seq, finalised } = await findFinalisedSeq(fid);
    const val = await statValidationV3(fid, seq, statKeys);
    return NextResponse.json({ finished: finalised, seq, val }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
