// TornaFan keeper: watch the game's TxLINE stat; when it moves, RESOLVE_ROUND (with a proof), then
// fan out SCORE_ONE for every player IN PARALLEL (different players -> different leaves -> same slot).
// This is what keeps the leaderboard live during a match.
//
//   WALLET_KEYPAIR=.. SOLANA_RPC_URL=.. TXLINE_GUEST_JWT=.. TXLINE_API_TOKEN=.. [MAX_ROUNDS=1] [POLL_MS=6000] npx tsx scripts/fan-keeper.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { resolveRoundIx, scoreOneIx, buildValidateStatPayload, gamePda } from "../src/lib/orderbook";

const HOST = "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL!;
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? "0"); // 0 = run forever
const POLL_MS = Number(process.env.POLL_MS ?? "6000");
const here = (p: string) => join(import.meta.dirname, p);
const fan = JSON.parse(readFileSync(here("../src/lib/fan.json"), "utf8"));
const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, ok404 = false): Promise<T | null> {
  const r = await fetch(`${HOST}/api${path}`, { headers: { Authorization: `Bearer ${process.env.TXLINE_GUEST_JWT}`, "X-Api-Token": process.env.TXLINE_API_TOKEN! } });
  if (r.status === 404 && ok404) return null;
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

// latest PROCESSED v3 proof for our stat, with its value. Probes seqs descending from the newest row.
async function latestProven(fixtureId: number, statKey: number): Promise<{ seq: number; value: number; val: any } | null> {
  const rows = await api<{ Seq?: number }[]>(`/scores/snapshot/${fixtureId}`);
  const seqs = [...new Set((rows ?? []).map((r) => r.Seq ?? 0))].sort((a, b) => b - a).slice(0, 20);
  for (const seq of seqs) {
    const val = await api<any>(`/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKey}`, true);
    if (val && val.statsToProve?.length) return { seq, value: val.statsToProve[0].stat.value, val };
  }
  return null;
}

function readGame() {
  return reader.accountData(gamePda(new PublicKey(fan.program), BigInt(fan.gameId))[0]).then((d) => {
    if (!d) throw new Error("game not found");
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    return { roundId: dv.getUint32(117, true), prevValue: dv.getInt32(121, true) };
  });
}

async function main() {
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.WALLET_KEYPAIR!, "utf8"))));
  const program = new PublicKey(fan.program);
  const torna = new PublicKey(fan.tornaProgramId);
  const gameId = BigInt(fan.gameId);
  const tree = new Tree(torna, new PublicKey(fan.creator), fan.lbTreeId);
  const oracleProgram = new PublicKey(fan.oracleProgram);
  console.log(`keeper up · game ${fan.gameId} · fixture ${fan.fixtureId} · stat ${fan.statKey}`);

  let resolved = 0;
  for (;;) {
    const { roundId, prevValue } = await readGame();
    const proven = await latestProven(Number(fan.fixtureId), fan.statKey);
    if (!proven) { console.log("  no processed proof yet; waiting…"); await sleep(POLL_MS); continue; }
    if (proven.value === prevValue) { console.log(`  round ${roundId}: stat still ${prevValue}; waiting…`); await sleep(POLL_MS); continue; }

    // the stat moved -> resolve this round
    console.log(`\n[round ${roundId}] stat ${prevValue} -> ${proven.value}; resolving …`);
    const { payload, epochDay } = buildValidateStatPayload(proven.val);
    const rIx = resolveRoundIx({ program, gameId, caller: payer.publicKey, oracleProgram, payload, epochDay });
    await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), rIx), [payer], { commitment: "confirmed" });
    const outcome = proven.value > prevValue ? "HIGHER" : "LOWER";
    console.log(`  resolved -> ${outcome}. scoring ${fan.players.length} players IN PARALLEL …`);

    // fan out SCORE_ONE in parallel (different players -> different leaves -> same slot)
    const results = await Promise.allSettled(fan.players.map(async (p: any) => {
      const player = new PublicKey(p.pubkey);
      const ix = await scoreOneIx({ reader, program, gameId, roundId, caller: payer.publicKey, player, torna, lbTree: tree });
      return sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix), [payer], { commitment: "confirmed" });
    }));
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.log(`  scored ${ok}/${fan.players.length} (${results.length - ok} skipped: no pick / already scored)`);

    if (MAX_ROUNDS && ++resolved >= MAX_ROUNDS) { console.log(`\nreached MAX_ROUNDS=${MAX_ROUNDS}; exiting.`); break; }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { console.error("keeper FAILED:", e.message); process.exit(1); });
