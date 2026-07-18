/**
 * Pre-deploy de-risk: prove the RESOLVE path works WITHOUT deploying our program, by simulating
 * txoracle.validate_stat_v3 directly on devnet with our real payload. Closes the biggest unknowns:
 *   #7 payload accepted?  #8 actual CU (vs the 1.4M ceiling)?  #9 base64 vs hex?  #10 activation?
 *
 *   # option A: provision tokens inline (needs a funded devnet wallet)
 *   RELAYER_SECRET=<base58> FIXTURE_ID=<finished fixture> npx tsx scripts/txline-derisk.ts
 *   # option B: reuse already-provisioned tokens
 *   TXLINE_GUEST_JWT=... TXLINE_API_TOKEN=... FIXTURE_ID=<finished> npx tsx scripts/txline-derisk.ts
 *
 * Prints: the raw v3 JSON (eyeball base64/hex), the simulation logs, unitsConsumed, and the bool.
 */
import "../src/lib/polyfill";
import { Connection, PublicKey, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { buildValidateStatPayload, scoresRootPda, TXORACLE_DEVNET, homeWin, type PredicateSpec } from "../src/lib/orderbook";

const HOST = "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const FIXTURE_ID = Number(process.env.FIXTURE_ID || "0");
const PREDICATE: PredicateSpec = homeWin();
const STAT_KEYS = [1, 2];
const VALIDATE_STAT_V3_DISC = Uint8Array.of(150, 37, 155, 89, 141, 190, 77, 203);

const b = (parts: Uint8Array[]) => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const u8 = (v: number) => Uint8Array.of(v & 0xff);
const u32 = (v: number) => { const x = new Uint8Array(4); new DataView(x.buffer).setUint32(0, v, true); return x; };
const i32 = (v: number) => { const x = new Uint8Array(4); new DataView(x.buffer).setInt32(0, v, true); return x; };

/** Borsh-encode NDimensionalStrategy for a 1- or 2-leg predicate (mirrors build_strategy in lib.rs). */
function encodeStrategy(p: PredicateSpec): Uint8Array {
  const pred = b([i32(p.threshold), u8(p.cmp)]); // TraderPredicate { threshold i32, comparison u8 }
  const discrete = p.nLegs === 2
    ? b([u8(1), u8(0), u8(1), u8(p.op), pred])     // Binary{tag1, idx_a0, idx_b1, op, predicate}
    : b([u8(0), u8(0), pred]);                       // Single{tag0, index0, predicate}
  return b([u32(0), u8(0), u32(1), discrete]);       // geo=[], distance=None, discrete=[one]
}

async function guestStart(): Promise<string> {
  const r = await fetch(`${HOST}/auth/guest/start`, { method: "POST" });
  if (!r.ok) throw new Error(`guest/start ${r.status}`);
  return (await r.json() as { token: string }).token;
}

async function getTokens(): Promise<{ jwt: string; api: string }> {
  if (process.env.TXLINE_GUEST_JWT && process.env.TXLINE_API_TOKEN) {
    return { jwt: process.env.TXLINE_GUEST_JWT, api: process.env.TXLINE_API_TOKEN };
  }
  if (!process.env.RELAYER_SECRET) throw new Error("set TXLINE_GUEST_JWT+TXLINE_API_TOKEN, or RELAYER_SECRET to activate");
  // Delegate the full subscribe+activate to txline-activate.ts logic would duplicate a lot; for the
  // de-risk we only need a working API token. Easiest: run scripts/txline-activate.ts first and pass
  // its output via env. Fail loud so the operator does that.
  throw new Error("run `npx tsx scripts/txline-activate.ts >> .env.local` first, then re-run with the printed tokens in env");
}

async function api<T>(path: string, jwt: string, apiToken: string): Promise<T> {
  const r = await fetch(`${HOST}/api${path}`, { headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function main() {
  if (!FIXTURE_ID) throw new Error("set FIXTURE_ID to a finished World Cup fixture");
  const { jwt, api: apiToken } = await getTokens();

  // 1) finalised seq
  const rows = await api<{ StatusId?: number; Seq?: number }[]>(`/scores/snapshot/${FIXTURE_ID}`, jwt, apiToken);
  const fin = rows.filter((r) => r.StatusId === 100);
  const seq = process.env.SEQ ? Number(process.env.SEQ) : (fin.length ? fin : rows).reduce((m, r) => Math.max(m, r.Seq ?? 0), 0);
  console.log(`[seq] finalised=${fin.length > 0} seq=${seq}${process.env.SEQ ? " (SEQ override)" : ""} rows=${rows.length}`);

  // 2) v3 proof — print RAW so we can eyeball base64 vs hex (#9)
  const val = await api<any>(`/scores/stat-validation-v3?fixtureId=${FIXTURE_ID}&seq=${seq}&statKeys=${STAT_KEYS.join(",")}`, jwt, apiToken);
  console.log("\n[raw v3 proof — check the encoding of eventStatRoot / hash fields]:");
  console.log(JSON.stringify(val, null, 2).slice(0, 1600));
  console.log(`... stats: ${JSON.stringify((val.statsToProve ?? []).map((l: any) => l.stat))}`);

  // 3) build our payload + strategy, construct the direct validate_stat_v3 ix
  const { payload, epochDay, tsMs } = buildValidateStatPayload(val);
  const strategy = encodeStrategy(PREDICATE);
  const [roots] = scoresRootPda(TXORACLE_DEVNET, epochDay);
  console.log(`\n[payload] ${payload.length}B  epochDay=${epochDay} (ts=${tsMs})  roots=${roots.toBase58()}`);

  const conn = new Connection(RPC, "confirmed");
  const rootInfo = await conn.getAccountInfo(roots);
  console.log(`[roots account] exists=${!!rootInfo} owner=${rootInfo?.owner.toBase58() ?? "-"} (want ${TXORACLE_DEVNET.toBase58()})`);
  if (!rootInfo) console.log("  -> root not published yet on devnet; pick an older finished fixture (#4/root-timing)");

  const ix = new TransactionInstruction({
    programId: TXORACLE_DEVNET,
    keys: [{ pubkey: roots, isSigner: false, isWritable: false }],
    data: Buffer.from(b([VALIDATE_STAT_V3_DISC, payload, strategy])),
  });
  // fee payer must be a real (funded) account or the RPC returns AccountNotFound in simulation
  const payerPk = process.env.RELAYER_SECRET
    ? Keypair.fromSecretKey(bs58.decode(process.env.RELAYER_SECRET)).publicKey
    : Keypair.generate().publicKey;
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payerPk,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);

  // 4) simulate — the go/no-go (#7 accepted? #8 CU? result bool?)
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log("\n===== validate_stat_v3 SIMULATION =====");
  console.log("err:", JSON.stringify(sim.value.err));
  console.log("unitsConsumed:", sim.value.unitsConsumed, "(ceiling 1,400,000)");
  const rd = sim.value.returnData;
  if (rd?.data) {
    const bytes = Buffer.from(rd.data[0], "base64");
    console.log("returnData bool:", bytes[0] === 1, `(from ${rd.programId})`);
  } else {
    console.log("returnData: <none>");
  }
  console.log("\nlogs:"); (sim.value.logs ?? []).forEach((l) => console.log("  " + l));
}

main().catch((e) => { console.error("\nde-risk FAILED:", e.message); process.exit(1); });
