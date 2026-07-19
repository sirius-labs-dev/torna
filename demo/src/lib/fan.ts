// TornaFan game config (written by bringup-fan.ts). Server + client read this.
import { PublicKey } from "@solana/web3.js";
import fanJson from "./fan.json";

export interface FanPlayer { pubkey: string; secret: number[]; pick: 0 | 1 }
export interface FanConfig {
  cluster: string; rpcUrl: string; program: string; tornaProgramId: string; oracleProgram: string;
  gameId: string; lbTreeId: number; creator: string; game: string; lb: string; lbHeader: string;
  fixtureId: string; statKey: number; statPeriod: number; roundId: number; players: FanPlayer[];
}
export const FAN = fanJson as FanConfig;
export const fanProgram = () => new PublicKey(FAN.program);
export const fanGameId = () => BigInt(FAN.gameId);
export const STAT_LABEL: Record<number, string> = { 1: "France goals", 2: "England goals", 7: "corners", 8: "corners" };
