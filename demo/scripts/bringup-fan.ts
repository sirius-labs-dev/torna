// Devnet TornaFan bring-up: create the leaderboard Torna tree (value_size 40, authority = lb PDA),
// INIT_GAME (bind fixture + stat + txoracle + leaderboard), then a pool of demo players who each
// INIT_PLAYER + PLACE_PICK a Higher/Lower call for round 1. Writes src/lib/fan.json for the UI.
//
//   WALLET_KEYPAIR=.. ORDERBOOK_PROGRAM=.. TORNA_PROGRAM=.. RPC=.. FIXTURE_ID=.. npx tsx scripts/bringup-fan.ts
import "../src/lib/polyfill";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { Tree, keys, type AccountReader } from "torna-sdk";
import { transferAuthorityIx, initGameIx, initPlayerIx, placePickIx, gamePda, lbPda, TXORACLE_DEVNET } from "../src/lib/orderbook";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const VS = 40; // leaderboard value: score(8 BE) | streak(8 BE) | pad
const F = 8;
const GAME_ID = 1n;
const LB_TREE = 7;
// --- the stat we call Hi-Lo on ---
const FIXTURE_ID = BigInt(process.env.FIXTURE_ID ?? "18257865"); // default: France v England (de-risk)
const STAT_KEY = Number(process.env.STAT_KEY ?? "1");            // 1=home goals (de-risk); corners=7/8 live
const STAT_PERIOD = Number(process.env.STAT_PERIOD ?? "100");
const PREV_VALUE = Number(process.env.PREV_VALUE ?? "0");        // round-1 baseline the call is against
const ROUND_ID = 1;
const PICKS: (0 | 1)[] = [1, 1, 0, 1]; // Higher, Higher, Lower, Higher

const conn = new Connection(RPC, "confirmed");
const here = (p: string) => join(import.meta.dirname, p);
const loadKp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const reader: AccountReader = { async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } };
const rent = (n: number) => conn.getMinimumBalanceForRentExemption(n);
const send = (ixs: any[], signers: Keypair[]) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
const nodeSize = (f: number, vs: number) => Math.max(44 + (f + 1) * 32 + (f + 1) * vs, 44 + (f + 1) * 32 + (f + 2) * 8);

async function main() {
  const payer = loadKp(process.env.WALLET_KEYPAIR || join(homedir(), ".config/solana/id.json"));
  const program = new PublicKey(process.env.ORDERBOOK_PROGRAM || loadKp(here("../deploy/orderbook-keypair.json")).publicKey.toBase58());
  const torna = new PublicKey(process.env.TORNA_PROGRAM || loadKp(here("../deploy/torna-keypair.json")).publicKey.toBase58());
  const [game] = gamePda(program, GAME_ID);
  const [lb] = lbPda(program, GAME_ID);
  const tree = new Tree(torna, payer.publicKey, LB_TREE);
  console.log("program", program.toBase58(), "game", game.toBase58(), "lb", lb.toBase58());

  if (await reader.accountData(tree.headerPda()[0])) {
    console.error(`leaderboard tree ${LB_TREE} already exists. Bump GAME_ID/LB_TREE for a fresh game. Aborting.`);
    process.exit(1);
  }

  // 1) leaderboard tree: init, seed a sentinel (height -> 1), authority -> lb PDA
  console.log("init leaderboard tree ...");
  const rHdr = BigInt(await rent(146)), rAlloc = BigInt(await rent(32)), rNode = BigInt(await rent(nodeSize(F, VS)));
  await send([tree.initTreeIx(payer.publicKey, VS, F, rHdr, rAlloc)], [payer]);
  const sentKey = new Uint8Array(32).fill(0xff); // sorts last; never a real player key
  const sentVal = new Uint8Array(40);
  const cold = await tree.insertIx(reader, payer.publicKey, sentKey, sentVal, rNode);
  if (!cold) throw new Error("sentinel cold insert unresolved");
  await send([cold], [payer]);
  await send([transferAuthorityIx(torna, tree.headerPda()[0], payer.publicKey, lb)], [payer]);

  // 2) INIT_GAME
  console.log(`init game (fixture ${FIXTURE_ID}, statKey ${STAT_KEY}/p${STAT_PERIOD}, round ${ROUND_ID}, prev ${PREV_VALUE}) ...`);
  await send([initGameIx({
    program, gameId: GAME_ID, authority: payer.publicKey, torna, lbHeader: tree.headerPda()[0],
    oracleProgram: TXORACLE_DEVNET, fixtureId: FIXTURE_ID, statKey: STAT_KEY, statPeriod: STAT_PERIOD,
    roundId: ROUND_ID, prevValue: PREV_VALUE, rent: BigInt(await rent(131)),
  })], [payer]);

  // 3) demo players: fund + INIT_PLAYER + PLACE_PICK
  console.log("funding players + placing picks ...");
  const players = Array.from({ length: PICKS.length }, () => Keypair.generate());
  const rPlayer = BigInt(await rent(20)), rPick = BigInt(await rent(6));
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: p.publicKey, lamports: 20_000_000 })], [payer]);
    await send([initPlayerIx({ program, gameId: GAME_ID, payer: payer.publicKey, player: p.publicKey, rent: rPlayer })], [payer]);
    await send([placePickIx({ program, gameId: GAME_ID, roundId: ROUND_ID, player: p.publicKey, dir: PICKS[i], rent: rPick })], [payer, p]);
    console.log(`  player${i} ${p.publicKey.toBase58().slice(0, 4)} picked ${PICKS[i] ? "HIGHER" : "LOWER"}`);
  }

  const fan = {
    cluster: "devnet", rpcUrl: "https://api.devnet.solana.com",
    program: program.toBase58(), tornaProgramId: torna.toBase58(), oracleProgram: TXORACLE_DEVNET.toBase58(),
    gameId: GAME_ID.toString(), lbTreeId: LB_TREE, creator: payer.publicKey.toBase58(),
    game: game.toBase58(), lb: lb.toBase58(), lbHeader: tree.headerPda()[0].toBase58(),
    fixtureId: FIXTURE_ID.toString(), statKey: STAT_KEY, statPeriod: STAT_PERIOD, roundId: ROUND_ID,
    players: players.map((k, i) => ({ pubkey: k.publicKey.toBase58(), secret: Array.from(k.secretKey), pick: PICKS[i] })),
  };
  writeFileSync(here("../src/lib/fan.json"), JSON.stringify(fan, null, 2));
  console.log("\nDONE. wrote src/lib/fan.json (game", GAME_ID.toString(), ")");
}

main().catch((e) => { console.error(e); process.exit(1); });
