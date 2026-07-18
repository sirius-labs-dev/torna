/**
 * End-to-end settlement test on the live devnet market: fetch the finalised TxLINE proof, RESOLVE
 * (real CPI into txoracle from our deployed program), then REDEEM the winning side. Proves the whole
 * RESOLVE/REDEEM path with real funds on devnet.
 *
 *   WALLET_KEYPAIR=... SOLANA_RPC_URL=... TXLINE_GUEST_JWT=... TXLINE_API_TOKEN=... \
 *   FIXTURE_ID=18257865 SEQ=1195 npx tsx scripts/settle-test.ts
 */
import "../src/lib/polyfill";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { resolveIx, redeemIx, readResolution, buildValidateStatPayload } from "../src/lib/orderbook";

const HOST = "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL!;
const FIXTURE_ID = Number(process.env.FIXTURE_ID);
const SEQ = Number(process.env.SEQ);
const STAT_KEYS = [1, 2];

const here = (p: string) => join(import.meta.dirname, p);
const market = JSON.parse(readFileSync(here("../src/lib/market.json"), "utf8"));
const conn = new Connection(RPC, "confirmed");
const kp = (s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s));

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`${HOST}/api${path}`, { headers: { Authorization: `Bearer ${process.env.TXLINE_GUEST_JWT}`, "X-Api-Token": process.env.TXLINE_API_TOKEN! } });
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function main() {
  const payer = kp(JSON.parse(readFileSync(process.env.WALLET_KEYPAIR!, "utf8")));
  const orderbook = new PublicKey(market.orderbookProgramId);
  const marketId = BigInt(market.marketId);
  const pred = market.prediction;
  console.log(`market ${market.marketId} on ${market.orderbookProgramId} | fixture ${pred.fixtureId} | YES=${pred.label}`);

  // 1) finalised proof -> payload
  const val = await api<any>(`/scores/stat-validation-v3?fixtureId=${FIXTURE_ID}&seq=${SEQ}&statKeys=${STAT_KEYS.join(",")}`);
  console.log("final stats:", JSON.stringify(val.statsToProve.map((l: any) => l.stat)));
  const { payload, epochDay } = buildValidateStatPayload(val);

  // 2) RESOLVE (real CPI)
  console.log("\n[RESOLVE] sending ...");
  const rIx = resolveIx({ orderbook, marketId, caller: payer.publicKey, oracleProgram: new PublicKey(pred.oracleProgram), payload, epochDay });
  const rSig = await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), rIx), [payer], { commitment: "confirmed" });
  console.log("  RESOLVE tx:", rSig);

  const res = await readResolution({ async accountData(k) { const a = await conn.getAccountInfo(k, "confirmed"); return a ? Uint8Array.from(a.data) : null; } }, orderbook, marketId);
  console.log("  resolution:", res, "->", res?.yesWon ? "YES won" : "NO won");
  if (!res?.resolved) throw new Error("not resolved");

  // 3) REDEEM the winning side with demo 0
  const holder = kp(market.demos[0].secret);
  const winningMint = new PublicKey(res.yesWon ? market.baseMint : pred.noMint);
  const quoteMint = new PublicKey(market.quoteMint);
  const holderQuote = getAssociatedTokenAddressSync(quoteMint, holder.publicKey, true);
  const before = Number((await getAccount(conn, holderQuote)).amount);
  const winAcct = getAssociatedTokenAddressSync(winningMint, holder.publicKey, true);
  const winBal = Number((await getAccount(conn, winAcct)).amount);
  console.log(`\n[REDEEM] demo0 holds ${winBal} winning shares, ${before} quote. Redeeming 50 ...`);
  const dIx = redeemIx({ orderbook, marketId, holder: holder.publicKey, amount: 50n, winningMint, quoteMint, quoteVault: new PublicKey(market.quoteVault) });
  const dSig = await sendAndConfirmTransaction(conn, new Transaction().add(dIx), [payer, holder], { commitment: "confirmed" });
  console.log("  REDEEM tx:", dSig);
  const after = Number((await getAccount(conn, holderQuote)).amount);
  console.log(`  quote: ${before} -> ${after} (+${after - before}); payout=${pred.payout}/share, 50 shares expected +${50 * Number(pred.payout)}`);
  console.log("\n✅ END-TO-END SETTLEMENT COMPLETE");
}

main().catch((e) => { console.error("\nsettle FAILED:", e.message); process.exit(1); });
