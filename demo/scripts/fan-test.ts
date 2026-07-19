// End-to-end TornaFan de-risk: RESOLVE_ROUND (verify the stat via a TxLINE proof, stamp Higher/Lower)
// then SCORE_ONE for every player, and scan the leaderboard tree to confirm scores. Proves the whole
// pick'em flow on devnet.
//   WALLET_KEYPAIR=.. SOLANA_RPC_URL=.. TXLINE_GUEST_JWT=.. TXLINE_API_TOKEN=.. SEQ=1195 npx tsx scripts/fan-test.ts
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import { resolveRoundIx, scoreOneIx, buildValidateStatPayload, decodeLbValue, gamePda } from "../src/lib/orderbook";

const HOST = "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL!;
const here = (p: string) => join(import.meta.dirname, p);
const fan = JSON.parse(readFileSync(here("../src/lib/fan.json"), "utf8"));
const conn = new Connection(RPC, "confirmed");
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const kp = (s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s));

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${HOST}/api${path}`, { headers: { Authorization: `Bearer ${process.env.TXLINE_GUEST_JWT}`, "X-Api-Token": process.env.TXLINE_API_TOKEN! } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function main() {
  const payer = kp(JSON.parse(readFileSync(process.env.WALLET_KEYPAIR!, "utf8")));
  const program = new PublicKey(fan.program);
  const torna = new PublicKey(fan.tornaProgramId);
  const gameId = BigInt(fan.gameId);
  const seq = Number(process.env.SEQ);
  const tree = new Tree(torna, new PublicKey(fan.creator), fan.lbTreeId);

  // 1) proof for our stat -> payload
  const val = await api<any>(`/scores/stat-validation-v3?fixtureId=${fan.fixtureId}&seq=${seq}&statKeys=${fan.statKey}`);
  console.log("proven stat:", JSON.stringify(val.statsToProve.map((l: any) => l.stat)));
  const { payload, epochDay } = buildValidateStatPayload(val);

  // 2) RESOLVE_ROUND
  console.log("\n[RESOLVE_ROUND] ...");
  const rIx = resolveRoundIx({ program, gameId, caller: payer.publicKey, oracleProgram: new PublicKey(fan.oracleProgram), payload, epochDay });
  const rSig = await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), rIx), [payer], { commitment: "confirmed" });
  console.log("  tx:", rSig);
  const g = await reader.accountData(gamePda(program, gameId)[0]);
  const outcome = g![129]; // G_OUTCOME
  console.log("  round outcome:", outcome === 1 ? "HIGHER" : "LOWER");

  // 3) SCORE_ONE for each player (parallel-capable; sequential here for a clean log)
  console.log("\n[SCORE_ONE] scoring players ...");
  for (const p of fan.players) {
    const player = new PublicKey(p.pubkey);
    const ix = await scoreOneIx({ reader, program, gameId, roundId: fan.roundId, caller: payer.publicKey, player, torna, lbTree: tree });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ix), [payer], { commitment: "confirmed" });
    console.log(`  ${p.pubkey.slice(0, 4)} (${p.pick ? "HIGHER" : "LOWER"}) scored -> ${sig.slice(0, 8)}…`);
  }

  // 4) scan the leaderboard tree -> ranked
  console.log("\n[LEADERBOARD] scanning Torna tree ...");
  const rows = await tree.scan(reader, 64);
  const board = rows
    .filter((e) => !e.key.every((b) => b === 0xff)) // drop the sentinel
    .map((e) => ({ player: new PublicKey(e.key).toBase58(), ...decodeLbValue(e.value) }))
    .sort((a, b) => b.score - a.score || b.streak - a.streak);
  board.forEach((r, i) => console.log(`  #${i + 1}  ${r.player.slice(0, 4)}  score ${r.score}  streak ${r.streak}`));
  console.log("\n✅ TORNAFAN END-TO-END COMPLETE");
}

main().catch((e) => { console.error("\nfan-test FAILED:", e.message); process.exit(1); });
