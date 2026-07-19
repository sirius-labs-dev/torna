// GET /api/fan/round — the game's current open round, the stat, its baseline value, and the last
// resolved round's Higher/Lower outcome. Read straight from the game config PDA.
import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import fan from "@/lib/fan.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const RPC = process.env.RPC_URL || fan.rpcUrl || "https://api.devnet.solana.com";

export async function GET() {
  try {
    const conn = new Connection(RPC, "confirmed");
    const info = await conn.getAccountInfo(new PublicKey(fan.game), "confirmed");
    if (!info) return NextResponse.json({ error: "game not found" }, { status: 404 });
    const d = info.data;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    // offsets mirror G_* in orderbook/src/lib.rs
    const roundId = dv.getUint32(117, true);
    const prevValue = dv.getInt32(121, true);
    const lastRound = dv.getUint32(125, true);
    const outcome = d[129]; // 0=lower,1=higher,2=none
    // the last write to the game PDA is the most recent RESOLVE_ROUND — surface it as the
    // verifiable settlement receipt (the tx that ran the TxLINE proof CPI on-chain).
    let lastTx: string | null = null;
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(fan.game), { limit: 1 }, "confirmed");
      lastTx = sigs[0]?.signature ?? null;
    } catch { /* receipt is best-effort */ }
    return NextResponse.json({
      gameId: fan.gameId, fixtureId: fan.fixtureId, statKey: fan.statKey,
      roundId, prevValue, lastRound, lastOutcome: outcome === 2 ? null : outcome === 1 ? "higher" : "lower", lastTx,
    }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
