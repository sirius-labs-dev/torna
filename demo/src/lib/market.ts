// The deployed devnet market (written by scripts/bringup.ts). Single source the UI reads:
// program IDs, the market PDAs, mints/vaults, and the pre-funded demo identities used to sign
// place/cancel/match in the browser (devnet-only; never real funds).
import "./polyfill";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Tree, type AccountReader } from "torna-sdk";
import marketJson from "./market.json";

export interface DemoIdentity {
  pubkey: string;
  secret: number[];
}
export interface Market {
  cluster: string;
  rpcUrl: string;
  tornaProgramId: string;
  orderbookProgramId: string;
  marketId: string;
  bookBump: number;
  creator: string;
  askTreeId: number;
  bidTreeId: number;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  book: string;
  cfg: string;
  demos: DemoIdentity[];
  // prediction-market extension (present only for markets brought up by bringup-prediction.ts):
  // base == YES share, plus a NO mint, the TxLINE fixture this market settles on, the per-share
  // payout, the txoracle program, a human label for the YES outcome, and the stat keys (leg order)
  // to request the settlement proof for. The predicate itself lives on-chain in the res PDA.
  prediction?: {
    noMint: string;
    fixtureId: string;
    oracleProgram: string;
    payout: string;
    label: string;
    statKeys: number[];
    home?: string;
    away?: string;
    competition?: string;
    resolveTx?: string;
  };
}

export const MARKET = marketJson as Market;

// RPC endpoint: prefer a dedicated NEXT_PUBLIC_RPC_URL (Helius/Triton/etc., far fewer 429s than
// the shared public devnet RPC), fall back to the deployment's rpcUrl. One shared Connection is
// reused across the app so web3.js can coalesce + rate-limit-retry centrally.
export const rpcUrl = (): string => process.env.NEXT_PUBLIC_RPC_URL || MARKET.rpcUrl;

let _conn: Connection | undefined;
export const connection = (): Connection => {
  if (!_conn) _conn = new Connection(rpcUrl(), "confirmed");
  return _conn;
};

export const reader = (conn: Connection = connection()): AccountReader => ({
  async accountData(key: PublicKey): Promise<Uint8Array | null> {
    const info = await conn.getAccountInfo(key, "confirmed");
    return info ? Uint8Array.from(info.data) : null;
  },
});

export const tornaProgram = (): PublicKey => new PublicKey(MARKET.tornaProgramId);
export const orderbookProgram = (): PublicKey => new PublicKey(MARKET.orderbookProgramId);
export const marketId = (): bigint => BigInt(MARKET.marketId);

export const askTree = (): Tree => new Tree(tornaProgram(), new PublicKey(MARKET.creator), MARKET.askTreeId);
export const bidTree = (): Tree => new Tree(tornaProgram(), new PublicKey(MARKET.creator), MARKET.bidTreeId);

export const demoKeypair = (i: number): Keypair =>
  Keypair.fromSecretKey(Uint8Array.from(MARKET.demos[i].secret));

/** The prediction-market config, or throws if this market is a plain CLOB (no settlement layer). */
export const prediction = () => {
  if (!MARKET.prediction) throw new Error("this market has no prediction/settlement layer (run bringup-prediction.ts)");
  return MARKET.prediction;
};
export const isPredictionMarket = (): boolean => !!MARKET.prediction;

const short = (s: string): string => `${s.slice(0, 4)}…${s.slice(-4)}`;
export const shorten = short;

const base = "https://explorer.solana.com";
export const explorerAddr = (addr: string): string => `${base}/address/${addr}?cluster=devnet`;
export const explorerTx = (sig: string): string => `${base}/tx/${sig}?cluster=devnet`;
