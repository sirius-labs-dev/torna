/**
 * One-time TxLINE provisioning: guest/start -> on-chain subscribe -> sign -> activate.
 * Prints TXLINE_GUEST_JWT and TXLINE_API_TOKEN to paste into .env.local. Run once (free tier is
 * fee-waived for the World Cup event); the runtime relayer never subscribes again.
 *
 *   npx tsx scripts/txline-activate.ts >> .env.local
 *
 * Requires (activation-only, not needed at runtime):
 *   npm i -D tsx bs58 tweetnacl
 *
 * Env:
 *   TXLINE_NETWORK=devnet
 *   SOLANA_RPC_URL=https://api.devnet.solana.com
 *   RELAYER_SECRET=<base58 secret key of the subscribing wallet>   (needs a little devnet SOL)
 *   TXLINE_SERVICE_LEVEL=1   (1 = 60s delay; 12 = real-time. Free for the World Cup tier.)
 *   TXLINE_WEEKS=4           (>=4, multiple of 4)
 *
 * Exact subscribe + activation formats verified against TxLINE's txoracle IDL v1.5.6 and two
 * independent community SDKs (@beriktassuly/txline, @h4rsharma/txline-settle).
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import nacl from "tweetnacl";

const NETWORK = process.env.TXLINE_NETWORK || "devnet";
const HOST = NETWORK === "mainnet" ? "https://txline.txodds.com" : "https://txline-dev.txodds.com";
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const SERVICE_LEVEL = Number(process.env.TXLINE_SERVICE_LEVEL ?? "1");
const WEEKS = Number(process.env.TXLINE_WEEKS ?? "4");

// TxLINE txoracle (devnet) + Token-2022 plumbing (docs: /documentation/programs/devnet).
const PROGRAM = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
// Anchor sha256("global:subscribe")[..8]
const SUBSCRIBE_DISC = Uint8Array.of(254, 28, 191, 138, 156, 179, 183, 53);

function wallet(): Keypair {
  const s = process.env.RELAYER_SECRET;
  if (!s) throw new Error("set RELAYER_SECRET (base58 secret key of a devnet wallet with some SOL)");
  return Keypair.fromSecretKey(bs58.decode(s));
}
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
// Token-2022 ATA (owner may be off-curve, e.g. a treasury PDA)
const ata2022 = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATOKEN)[0];

// ---- step 1: guest JWT ----
async function guestStart(): Promise<string> {
  const res = await fetch(`${HOST}/auth/guest/start`, { method: "POST" });
  if (!res.ok) throw new Error(`guest/start ${res.status}`);
  return (await res.json() as { token: string }).token;
}

// ---- step 2: on-chain subscribe (free World Cup tier) ----
// data: disc(8) | serviceLevelId u16 LE | weeks u8
// accounts: user(ws), pricing_matrix, txl_mint, user_txl_ata(w), treasury_vault_ata(w),
//           token_treasury_v2, TOKEN_2022, SYSTEM, ATOKEN
function subscribeIx(user: PublicKey): { ix: TransactionInstruction; userTxlAta: PublicKey } {
  const pricingMatrix = pda([Buffer.from("pricing_matrix")]);
  const tokenTreasury = pda([Buffer.from("token_treasury_v2")]);
  const userTxlAta = ata2022(user, TXL_MINT);
  const treasuryVaultAta = ata2022(tokenTreasury, TXL_MINT);
  const data = new Uint8Array(8 + 2 + 1);
  data.set(SUBSCRIBE_DISC, 0);
  new DataView(data.buffer).setUint16(8, SERVICE_LEVEL, true);
  data[10] = WEEKS;
  const k = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
  const ix = new TransactionInstruction({
    programId: PROGRAM,
    data: Buffer.from(data),
    keys: [
      k(user, true, true), k(pricingMatrix, false, false), k(TXL_MINT, false, false),
      k(userTxlAta, false, true), k(treasuryVaultAta, false, true), k(tokenTreasury, false, false),
      k(TOKEN_2022, false, false), k(SystemProgram.programId, false, false), k(ATOKEN, false, false),
    ],
  });
  return { ix, userTxlAta };
}

async function subscribe(payer: Keypair): Promise<string> {
  const conn = new Connection(RPC, "confirmed");
  const { ix, userTxlAta } = subscribeIx(payer.publicKey);
  // ensure the user's TXL ATA exists (idempotent); free tier moves 0 TXL but the account must exist
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    payer.publicKey, userTxlAta, payer.publicKey, TXL_MINT, TOKEN_2022, ATOKEN,
  );
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ataIx)
    .add(ix);
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

// ---- step 3: sign the activation message ----
// Message = `${txSig}:${leagues.join(",")}:${jwt}` (empty leagues => `${txSig}::${jwt}`), signed
// NaCl-detached with the SUBSCRIBING wallet, base64-encoded. Verified against both community SDKs.
function signActivation(kp: Keypair, jwt: string, txSig: string, leagues: number[]): string {
  const msg = `${txSig}:${leagues.join(",")}:${jwt}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey);
  return Buffer.from(sig).toString("base64");
}

// ---- step 4: activate -> long-lived API token ----
async function activate(jwt: string, txSig: string, walletSignature: string, leagues: number[]): Promise<string> {
  const res = await fetch(`${HOST}/api/token/activate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ txSig, walletSignature, leagues }),
  });
  if (!res.ok) throw new Error(`token/activate ${res.status}: ${await res.text()}`);
  return (await res.json() as { token: string }).token;
}

async function main() {
  const kp = wallet();
  const leagues: number[] = []; // [] = standard/free matrix (all World Cup leagues in the tier)
  console.error(`[1/4] guest/start on ${HOST} ...`);
  const jwt = await guestStart();
  console.error(`[2/4] subscribe (SL ${SERVICE_LEVEL}, ${WEEKS}w) as ${kp.publicKey.toBase58()} ...`);
  const txSig = await subscribe(kp);
  console.error(`      subscribed: ${txSig}`);
  console.error(`[3/4] sign activation ...`);
  const walletSignature = signActivation(kp, jwt, txSig, leagues);
  console.error(`[4/4] token/activate ...`);
  const apiToken = await activate(jwt, txSig, walletSignature, leagues);

  console.log(`TXLINE_NETWORK=${NETWORK}`);
  console.log(`TXLINE_GUEST_JWT=${jwt}`);
  console.log(`TXLINE_API_TOKEN=${apiToken}`);
}

main().catch((e) => { console.error("activation failed:", e.message); process.exit(1); });
