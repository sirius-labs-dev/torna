// GET /api/leaderboard — scan the on-chain Torna leaderboard tree and return the ranked players.
// Same load-balancer pattern as /api/book: one cached upstream read per TTL, served to all viewers.
import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { decodeLbValue } from "@/lib/orderbook";
import fan from "@/lib/fan.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC = process.env.RPC_URL || fan.rpcUrl || "https://api.devnet.solana.com";
const TTL_MS = 4_000;
const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const tree = new Tree(new PublicKey(fan.tornaProgramId), new PublicKey(fan.creator), fan.lbTreeId);

let cache: { at: number; rows: unknown[] } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ leaderboard: cache.rows }, { headers: { "cache-control": "public, max-age=3" } });
  }
  try {
    const entries = await tree.scan(reader, 64);
    const rows = entries
      .filter((e) => !e.key.every((b) => b === 0xff)) // drop the sentinel
      .map((e) => ({ player: new PublicKey(e.key).toBase58(), ...decodeLbValue(e.value) }))
      .sort((a, b) => b.score - a.score || b.streak - a.streak);
    cache = { at: Date.now(), rows };
    return NextResponse.json({ leaderboard: rows }, { headers: { "cache-control": "public, max-age=3" } });
  } catch (e) {
    if (cache) return NextResponse.json({ leaderboard: cache.rows });
    return NextResponse.json({ leaderboard: [], error: e instanceof Error ? e.message : String(e) });
  }
}
