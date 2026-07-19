// GET /api/fan/proven — the "already played" leaderboard: the France v England game (game 2) that
// ran to completion on-chain, scored round by round against TxLINE proofs. Lets the /fan page show
// the game *in action* (a real, moving, provably-fair board) alongside the live final, on one page.
import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { decodeLbValue } from "@/lib/orderbook";
import fan from "@/lib/fan.france.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RPC = process.env.RPC_URL || fan.rpcUrl || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const tree = new Tree(new PublicKey(fan.tornaProgramId), new PublicKey(fan.creator), fan.lbTreeId);

export async function GET() {
  try {
    const entries = await tree.scan(reader, 64);
    const rows = entries
      .filter((e) => !e.key.every((b) => b === 0xff))
      .map((e) => ({ player: new PublicKey(e.key).toBase58(), ...decodeLbValue(e.value) }))
      .sort((a, b) => b.score - a.score || b.streak - a.streak);
    // last RESOLVE_ROUND on the game PDA — the verifiable "provably fair" receipt
    let lastTx: string | null = null;
    try {
      const sigs = await conn.getSignaturesForAddress(new PublicKey(fan.game), { limit: 1 }, "confirmed");
      lastTx = sigs[0]?.signature ?? null;
    } catch { /* best-effort */ }
    return NextResponse.json({ leaderboard: rows, lastTx, home: "France", away: "England" }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ leaderboard: [], error: e instanceof Error ? e.message : String(e) });
  }
}
