"use client";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { placePickIx } from "./orderbook";
import { FAN, fanProgram, fanGameId } from "./fan";

const conn = () => new Connection(process.env.NEXT_PUBLIC_RPC_URL || FAN.rpcUrl, "confirmed");

/** Place a Higher(1)/Lower(0) call for `roundId` as a pre-funded demo player. */
export async function placePick(playerSecret: number[], roundId: number, dir: 0 | 1): Promise<string> {
  const player = Keypair.fromSecretKey(Uint8Array.from(playerSecret));
  const c = conn();
  const rent = BigInt(await c.getMinimumBalanceForRentExemption(6));
  const ix = placePickIx({ program: fanProgram(), gameId: fanGameId(), roundId, player: player.publicKey, dir, rent });
  return sendAndConfirmTransaction(c, new Transaction().add(ix), [player], { commitment: "confirmed" });
}
