// TornaFan replay/demo driver: drive the live leaderboard through N rounds so it visibly MOVES —
// for recording the demo, or to make the deployed board self-demonstrate. Each round: place varied
// picks for the demo players, RESOLVE_ROUND with a REAL TxLINE proof, then parallel-score everyone.
// With one real proof (value V): round 1 (prev 0 -> V) resolves HIGHER, later rounds (prev V -> V)
// resolve LOWER — so varied picks make different players win each round and the board reshuffles.
//
//   WALLET_KEYPAIR=.. SOLANA_RPC_URL=.. TXLINE_GUEST_JWT=.. TXLINE_API_TOKEN=.. SEQ=1195 ROUNDS=6 DELAY_MS=4000 npx tsx scripts/fan-replay.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { resolveRoundIx, scoreOneIx, placePickIx, buildValidateStatPayload, decodeLbValue, gamePda } from "../src/lib/orderbook";

const HOST = "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL!;
const SEQ = Number(process.env.SEQ ?? "1195");
const ROUNDS = Number(process.env.ROUNDS ?? "6");
const DELAY_MS = Number(process.env.DELAY_MS ?? "4000");
const here = (p: string) => join(import.meta.dirname, p);
const fan = JSON.parse(readFileSync(here("../src/lib/fan.json"), "utf8"));
const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const kp = (s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${HOST}/api${path}`, { headers: { Authorization: `Bearer ${process.env.TXLINE_GUEST_JWT}`, "X-Api-Token": process.env.TXLINE_API_TOKEN! } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`);
  return r.json() as Promise<T>;
}
const readRound = () => reader.accountData(gamePda(new PublicKey(fan.program), BigInt(fan.gameId))[0]).then((d) => new DataView(d!.buffer, d!.byteOffset, d!.byteLength).getUint32(117, true));

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
  const val = await api<any>(`/scores/stat-validation-v3?fixtureId=${fan.fixtureId}&seq=${SEQ}&statKeys=${fan.statKey}`);
  const { payload, epochDay } = buildValidateStatPayload(val);
  console.log(`replay · game ${fan.gameId} · ${ROUNDS} rounds · proof value ${val.statsToProve[0].stat.value}`);
  const cbPick = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 });

  for (let i = 0; i < ROUNDS; i++) {
    const round = await readRound();
    // varied picks: player j calls HIGHER when (round + j) is even, else LOWER
    for (let j = 0; j < fan.players.length; j++) {
      const p = kp(fan.players[j].secret);
      const dir = ((round + j) % 2 === 0 ? 1 : 0) as 0 | 1;
      const rent = BigInt(await conn.getMinimumBalanceForRentExemption(6));
      try {
        const ix = placePickIx({ program, gameId, roundId: round, player: p.publicKey, dir, rent });
        await sendAndConfirmTransaction(conn, new Transaction().add(cbPick(), ix), [payer, p], { commitment: "confirmed" });
      } catch { /* already picked this round */ }
    }
    // resolve + parallel score
    const rIx = resolveRoundIx({ program, gameId, caller: payer.publicKey, oracleProgram, payload, epochDay });
    await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), rIx), [payer], { commitment: "confirmed" });
    await Promise.allSettled(fan.players.map(async (pl: any) => {
      const player = new PublicKey(pl.pubkey);
      const ix = await scoreOneIx({ reader, program, gameId, roundId: round, caller: payer.publicKey, player, torna, lbTree: tree });
      return sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix), [payer], { commitment: "confirmed" });
    }));
    const b = await board(tree);
    console.log(`\n[round ${round}] board:`);
    b.forEach((r, k) => console.log(`  #${k + 1} ${r.p}  ${r.score}pts  ${r.streak}🔥`));
    await sleep(DELAY_MS);
  }
  console.log("\n✅ replay done — the leaderboard moved across", ROUNDS, "rounds");
}

main().catch((e) => { console.error("replay FAILED:", e.message); process.exit(1); });
