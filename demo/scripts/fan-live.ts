// TornaFan LIVE driver (kickoff tool): make the leaderboard move during a real match using REAL,
// sequential TxLINE proofs. Each round: (1) place BLIND demo picks (before the outcome is known —
// provably fair), (2) wait for the next TxLINE update (a proven seq newer than the last one), (3)
// RESOLVE_ROUND with that real live proof, (4) parallel-score. One round per live update: on most
// updates the goal count is unchanged (LOWER wins), on a goal it jumps (HIGHER wins) — the real game.
//
// Unlike fan-replay (one fixed proof, for a finished match) this pulls the LATEST proven seq live.
// If TxLINE hasn't processed a v3 proof for a new seq yet, it just waits — nothing is faked.
//
//   WALLET_KEYPAIR=.. SOLANA_RPC_URL=.. TXLINE_GUEST_JWT=.. TXLINE_API_TOKEN=.. [MAX_ROUNDS=0] [POLL_MS=6000] npx tsx scripts/fan-live.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { resolveRoundIx, scoreOneIx, placePickIx, buildValidateStatPayload, decodeLbValue, gamePda } from "../src/lib/orderbook";

const HOST = "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL!;
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS ?? "0"); // 0 = run forever
const POLL_MS = Number(process.env.POLL_MS ?? "6000");
const here = (p: string) => join(import.meta.dirname, p);
const fan = JSON.parse(readFileSync(here("../src/lib/fan.json"), "utf8"));
const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const kp = (s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, ok404 = false): Promise<T | null> {
  const r = await fetch(`${HOST}/api${path}`, { headers: { Authorization: `Bearer ${process.env.TXLINE_GUEST_JWT}`, "X-Api-Token": process.env.TXLINE_API_TOKEN! } });
  if (r.status === 404 && ok404) return null;
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}

// newest PROCESSED v3 proof for our stat (seq + value + raw). Probes seqs descending from the feed.
async function latestProven(fixtureId: number, statKey: number): Promise<{ seq: number; value: number; val: any } | null> {
  const rows = await api<{ Seq?: number }[]>(`/scores/snapshot/${fixtureId}`);
  const seqs = [...new Set((rows ?? []).map((r) => r.Seq ?? 0))].sort((a, b) => b - a).slice(0, 25);
  for (const seq of seqs) {
    const val = await api<any>(`/scores/stat-validation-v3?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKey}`, true);
    if (val && val.statsToProve?.length) return { seq, value: val.statsToProve[0].stat.value, val };
  }
  return null;
}

const readRound = () => reader.accountData(gamePda(new PublicKey(fan.program), BigInt(fan.gameId))[0]).then((d) => {
  const dv = new DataView(d!.buffer, d!.byteOffset, d!.byteLength);
  return { roundId: dv.getUint32(117, true), prevValue: dv.getInt32(121, true) };
});

async function board(tree: Tree) {
  const rows = await tree.scan(reader, 64);
  return rows.filter((e) => !e.key.every((b) => b === 0xff))
    .map((e) => ({ p: new PublicKey(e.key).toBase58().slice(0, 4), ...decodeLbValue(e.value) }))
    .sort((a, b) => b.score - a.score || b.streak - a.streak);
}

async function main() {
  const payer = kp(JSON.parse(readFileSync(process.env.WALLET_KEYPAIR!, "utf8")));
  const program = new PublicKey(fan.program), torna = new PublicKey(fan.tornaProgramId), gameId = BigInt(fan.gameId);
  const tree = new Tree(torna, new PublicKey(fan.creator), fan.lbTreeId);
  const oracleProgram = new PublicKey(fan.oracleProgram);
  const fixtureId = Number(fan.fixtureId);
  console.log(`LIVE keeper up · game ${fan.gameId} · fixture ${fixtureId} · stat ${fan.statKey} (${fan.statLabel ?? "goals"})`);

  // baseline: don't resolve against a proof that predates our first blind picks
  let lastSeq = (await latestProven(fixtureId, fan.statKey))?.seq ?? -1;
  console.log(`baseline seq ${lastSeq}; waiting for the next live update after picks…`);
  let resolved = 0;

  for (;;) {
    const { roundId, prevValue } = await readRound();
    // 1) BLIND picks for this round — placed before the next update is known
    for (let j = 0; j < fan.players.length; j++) {
      const p = kp(fan.players[j].secret);
      const dir = ((roundId + j) % 2 === 0 ? 1 : 0) as 0 | 1;
      const rent = BigInt(await conn.getMinimumBalanceForRentExemption(6));
      try {
        const ix = placePickIx({ program, gameId, roundId, player: p.publicKey, dir, rent });
        await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ix), [payer, p], { commitment: "confirmed" });
      } catch { /* already picked this round */ }
    }

    // 2) wait for the next live TxLINE update (a proven seq newer than the last we resolved)
    let proven = await latestProven(fixtureId, fan.statKey);
    while (!proven || proven.seq <= lastSeq) {
      process.stdout.write(`  round ${roundId}: waiting for next live update (seq>${lastSeq}, stat ${prevValue})…\r`);
      await sleep(POLL_MS);
      proven = await latestProven(fixtureId, fan.statKey);
    }
    lastSeq = proven.seq;

    // 3) resolve with the real live proof + 4) parallel score
    const outcome = proven.value > prevValue ? "HIGHER" : "LOWER";
    console.log(`\n[round ${roundId}] live update seq ${proven.seq}: stat ${prevValue} -> ${proven.value} (${outcome}); resolving…`);
    const { payload, epochDay } = buildValidateStatPayload(proven.val);
    const rIx = resolveRoundIx({ program, gameId, caller: payer.publicKey, oracleProgram, payload, epochDay });
    await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), rIx), [payer], { commitment: "confirmed" });
    await Promise.allSettled(fan.players.map(async (pl: any) => {
      const player = new PublicKey(pl.pubkey);
      const ix = await scoreOneIx({ reader, program, gameId, roundId, caller: payer.publicKey, player, torna, lbTree: tree });
      return sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix), [payer], { commitment: "confirmed" });
    }));
    const b = await board(tree);
    b.forEach((r, k) => console.log(`  #${k + 1} ${r.p}  ${r.score}pts  ${r.streak}🔥`));

    if (MAX_ROUNDS && ++resolved >= MAX_ROUNDS) { console.log(`\nreached MAX_ROUNDS=${MAX_ROUNDS}; exiting.`); break; }
  }
}

main().catch((e) => { console.error("LIVE keeper FAILED:", e.message); process.exit(1); });
