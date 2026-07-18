// TS client for the reference orderbook program (mirrors orderbook/src/lib.rs byte-for-byte;
// the proven oracle is integration/obtest.rs). The frontend AND the bring-up script use these
// builders. Path/spare resolution is delegated to torna-sdk; this layer adds the escrow CLOB
// instruction wire formats + the off-chain fill computation a taker needs for a match.
import "./polyfill";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// orderbook discriminators
const PLACE = 0;
const CANCEL = 1;
const MATCH = 2;
const PLACE_COLD = 3;
const INIT_MARKET = 4;
// prediction-market settlement discriminators (mirror orderbook/src/lib.rs)
const RESOLVE = 5;
const REDEEM = 6;
const INIT_OUTCOME = 7;
const MINT_SET = 8;
// torna engine discriminator used at setup
const TRANSFER_AUTHORITY = 11;

export const ASK = 0;
export const BID = 1;
export type Side = typeof ASK | typeof BID;

// torna node layout (mirrors abi.md)
const NODE_HDR = 44;
const N_KEY_COUNT = 2;
const N_NEXT_LEAF = 20;
const KEY_SIZE = 32;

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}
function u16le(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}
function concat(parts: Uint8Array[]): Buffer {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return Buffer.from(out);
}
function rdU16(d: Uint8Array, o: number): number {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o, true);
}
function rdU64le(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}
function rdU64be(d: Uint8Array, o: number): bigint {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, false);
}
const m = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

// ---- market PDAs ----
export function bookPda(orderbook: PublicKey, marketId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("book"), u64le(marketId)], orderbook);
}
export function cfgPda(orderbook: PublicKey, marketId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("mkt"), u64le(marketId)], orderbook);
}
/** Resolution PDA [b"res", market_id] — the prediction-market half of a market. */
export function resPda(orderbook: PublicKey, marketId: bigint): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("res"), u64le(marketId)], orderbook);
}
/** TxLINE daily_scores_roots PDA [b"daily_scores_roots", epochDay u16 LE] under the TxLINE program. */
export function scoresRootPda(txlineProgram: PublicKey, epochDay: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), u16le(epochDay)], txlineProgram);
}

/** Order value (40B): maker(32) | size_be(8). The SDK is value-agnostic; this is CLOB-specific. */
export function orderValue(maker: PublicKey, size: bigint): Uint8Array {
  const v = new Uint8Array(40);
  v.set(maker.toBytes(), 0);
  new DataView(v.buffer).setBigUint64(32, size, false); // big-endian
  return v;
}

export const sideEnum = (side: Side) => (side === ASK ? keys.Side.Ask : keys.Side.Bid);

// ---- setup instructions (used by the bring-up) ----

/** Torna TransferAuthority (disc 11): hand a tree's write authority to the book PDA. */
export function transferAuthorityIx(
  torna: PublicKey, headerPda: PublicKey, currentAuthority: PublicKey, newAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: torna,
    data: concat([Uint8Array.of(TRANSFER_AUTHORITY), newAuthority.toBytes()]),
    keys: [m(headerPda, false, true), m(currentAuthority, true, false)],
  });
}

/** InitMarket (disc 4): write + bind the market config PDA. */
export function initMarketIx(args: {
  orderbook: PublicKey; torna: PublicKey; marketId: bigint; payer: PublicKey;
  baseMint: PublicKey; quoteMint: PublicKey; baseVault: PublicKey; quoteVault: PublicKey;
  askHeader: PublicKey; bidHeader: PublicKey; askRoot: PublicKey; bidRoot: PublicKey; rent: bigint;
}): TransactionInstruction {
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg, cfgBump] = cfgPda(args.orderbook, args.marketId);
  const data = concat([
    Uint8Array.of(INIT_MARKET), u64le(args.marketId),
    Uint8Array.of(bump), Uint8Array.of(cfgBump), u64le(args.rent),
  ]);
  return new TransactionInstruction({
    programId: args.orderbook,
    data,
    keys: [
      m(args.payer, true, true), m(cfg, false, true), m(book, false, false),
      m(args.baseMint, false, false), m(args.quoteMint, false, false),
      m(args.baseVault, false, false), m(args.quoteVault, false, false),
      m(SystemProgram.programId, false, false),
      m(args.torna, false, false), m(args.askHeader, false, false), m(args.bidHeader, false, false),
      m(args.askRoot, false, false), m(args.bidRoot, false, false),
    ],
  });
}

// ---- trading instructions (used by the frontend) ----

/** PlaceOrder (disc 0, hot path InsertFast). Escrows base (ASK) or quote (BID), inserts. */
export async function placeIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  side: Side; price: bigint; size: bigint; nonce: bigint; slot?: bigint;
  maker: PublicKey; makerSrc: PublicKey; vault: PublicKey;
}): Promise<{ ix: TransactionInstruction; key: Uint8Array }> {
  const slot = args.slot ?? 0n;
  const key = keys.orderKey(sideEnum(args.side), args.price, slot, args.maker, args.nonce);
  const path = await args.tree.path(args.reader, key);
  if (!path) throw new Error("tree not initialized / path unresolved");
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const data = concat([
    Uint8Array.of(PLACE, args.side), u64le(args.price), u64le(args.size),
    u64le(slot), u64le(args.nonce), u64le(args.marketId), Uint8Array.of(bump),
  ]);
  const meta: AccountMeta[] = [
    m(args.maker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, false),
    m(args.makerSrc, false, true), m(args.vault, false, true), m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    ...path.map((n, i) => m(args.tree.nodePda(n)[0], false, i === path.length - 1)),
  ];
  return { ix: new TransactionInstruction({ programId: args.orderbook, data, keys: meta }), key };
}

/** PlaceOrderCold (disc 3): place into a FULL leaf via the cold Insert path (split). Same escrow as
 *  the hot place; resolves the descent path + spare node PDAs via the SDK cold plan. The maker signs
 *  and pays spare rent; the book PDA authorizes the engine Insert. Mirrors orderbook::place_cold. */
export async function placeColdIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  side: Side; price: bigint; size: bigint; nonce: bigint; slot?: bigint;
  maker: PublicKey; makerSrc: PublicKey; vault: PublicKey; rentNode: bigint;
}): Promise<{ ix: TransactionInstruction; key: Uint8Array } | null> {
  const slot = args.slot ?? 0n;
  const key = keys.orderKey(sideEnum(args.side), args.price, slot, args.maker, args.nonce);
  const plan = await args.tree.coldPlan(args.reader, key);
  if (!plan) return null;
  const { path, spares } = plan; // path: bigint[] (root..leaf); spares: [PublicKey, bump][] (height+2)
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const alloc = args.tree.allocPda()[0];
  const data = concat([
    Uint8Array.of(PLACE_COLD, args.side), u64le(args.price), u64le(args.size),
    u64le(slot), u64le(args.nonce), u64le(args.marketId), Uint8Array.of(bump),
    Uint8Array.of(path.length), Uint8Array.of(spares.length), u64le(args.rentNode),
    Uint8Array.from(spares.map(([, b]) => b)),
  ]);
  const meta: AccountMeta[] = [
    m(args.maker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, true),
    m(args.makerSrc, false, true), m(args.vault, false, true), m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    m(alloc, false, true), m(SystemProgram.programId, false, false),
    ...path.map((n) => m(args.tree.nodePda(n)[0], false, true)),
    ...spares.map(([pk]) => m(pk, false, true)),
  ];
  return { ix: new TransactionInstruction({ programId: args.orderbook, data, keys: meta }), key };
}

/** CancelOrder (disc 1): refund the escrow + remove the order. */
export async function cancelIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  side: Side; key: Uint8Array; maker: PublicKey; vault: PublicKey; makerDst: PublicKey;
}): Promise<TransactionInstruction> {
  const path = await args.tree.path(args.reader, args.key);
  if (!path) throw new Error("path unresolved");
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const data = concat([
    Uint8Array.of(CANCEL), args.key, Uint8Array.of(args.side), u64le(args.marketId), Uint8Array.of(bump),
  ]);
  const meta: AccountMeta[] = [
    m(args.maker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, false),
    m(args.vault, false, true), m(args.makerDst, false, true), m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    ...path.map((n, i) => m(args.tree.nodePda(n)[0], false, i === path.length - 1)),
  ];
  return new TransactionInstruction({ programId: args.orderbook, data, keys: meta });
}

export interface Fill { maker: PublicKey; price: bigint; fill: bigint; key: Uint8Array; leafIdx: bigint; }

/** Walk the book from leftmost (best) and compute the fills a taker at `limit`/`size` would get,
 *  mirroring the on-chain matcher's sweep (price-crossing, sentinel-skipping, leaf-chained). */
export async function computeFills(args: {
  reader: AccountReader; tree: Tree; bookSide: Side; limit: bigint; size: bigint; maxFills: number;
}): Promise<{ fills: Fill[]; leaves: bigint[]; height: number }> {
  const h = await args.tree.header(args.reader);
  if (!h || h.height === 0) return { fills: [], leaves: [], height: 0 };
  const voff = NODE_HDR + (h.fanout + 1) * KEY_SIZE;
  let idx = h.leftmost;
  let remaining = args.size;
  const fills: Fill[] = [];
  const leaves: bigint[] = [];
  outer: while (idx !== 0n && remaining > 0n && fills.length < args.maxFills) {
    const d = await args.reader.accountData(args.tree.nodePda(idx)[0]);
    if (!d) break;
    const cnt = rdU16(d, N_KEY_COUNT);
    let used = false;
    for (let i = 0; i < cnt && remaining > 0n && fills.length < args.maxFills; i++) {
      const key = d.slice(NODE_HDR + i * KEY_SIZE, NODE_HDR + i * KEY_SIZE + KEY_SIZE);
      const price = keys.priceOf(sideEnum(args.bookSide), key);
      const cross = args.bookSide === ASK ? price <= args.limit : price >= args.limit;
      if (!cross) break outer; // globally sorted -> first non-crosser ends it
      const vo = voff + i * h.valueSize;
      const resting = rdU64be(d, vo + 32);
      if (resting === 0n) continue; // sentinel / empty slot
      const fill = remaining < resting ? remaining : resting;
      const maker = new PublicKey(d.slice(vo, vo + 32));
      fills.push({ maker, price, fill, key, leafIdx: idx });
      remaining -= fill;
      used = true;
    }
    if (used) leaves.push(idx);
    idx = rdU64le(d, N_NEXT_LEAF);
  }
  return { fills, leaves, height: h.height };
}

/** Match (disc 2): a taker sweeps the crossing side, settling tokens atomically. Computes the
 *  fills off-chain, derives each maker's pay-mint ATA, and assembles the K-order match tx. */
export async function matchIx(args: {
  reader: AccountReader; tree: Tree; orderbook: PublicKey; torna: PublicKey; marketId: bigint;
  bookSide: Side; limit: bigint; size: bigint; maxFills: number;
  taker: PublicKey; vault: PublicKey; takerRecv: PublicKey; takerPay: PublicKey; payMint: PublicKey;
}): Promise<{ ix: TransactionInstruction; fills: Fill[] } | null> {
  const { fills, leaves, height } = await computeFills(args);
  if (fills.length === 0) return null;
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const header = args.tree.headerPda()[0];
  const nf = fills.length; // max_fills == actual fills so the leaf groups align at base = 9 + nf
  const data = concat([
    Uint8Array.of(MATCH, args.bookSide), u64le(args.limit), u64le(args.size),
    Uint8Array.of(nf), u64le(args.marketId), Uint8Array.of(bump),
    Uint8Array.of(leaves.length), Uint8Array.of(height),
  ]);
  const makerRecvs = fills.map((f) => m(getAssociatedTokenAddressSync(args.payMint, f.maker, true), false, true));
  // each swept leaf contributes its root..leaf path (height accounts), leftmost-first
  const groups: AccountMeta[] = [];
  for (const leaf of leaves) {
    let path: bigint[];
    if (height === 1) {
      path = [leaf];
    } else {
      const firstKey = await firstKeyOfLeaf(args.reader, args.tree, leaf);
      const p = firstKey ? await args.tree.path(args.reader, firstKey) : null;
      if (!p) return null;
      path = p;
    }
    path.forEach((n, i) => groups.push(m(args.tree.nodePda(n)[0], false, i === path.length - 1)));
  }
  const meta: AccountMeta[] = [
    m(args.taker, true, true), m(book, false, false), m(args.torna, false, false), m(header, false, false),
    m(args.vault, false, true), m(args.takerRecv, false, true), m(args.takerPay, false, true),
    m(TOKEN_PROGRAM, false, false), m(cfg, false, false),
    ...makerRecvs, ...groups,
  ];
  return { ix: new TransactionInstruction({ programId: args.orderbook, data, keys: meta }), fills };
}

async function firstKeyOfLeaf(reader: AccountReader, tree: Tree, leafIdx: bigint): Promise<Uint8Array | null> {
  const d = await reader.accountData(tree.nodePda(leafIdx)[0]);
  if (!d) return null;
  const cnt = rdU16(d, N_KEY_COUNT);
  if (cnt === 0) return null;
  return d.slice(NODE_HDR, NODE_HDR + KEY_SIZE);
}

// ============================================================================================
// Prediction-market settlement instructions (mirror the settlement section of orderbook/src/lib.rs)
// ============================================================================================

// TxLINE txoracle (devnet) — owns daily_scores_roots and exposes validate_stat_v3.
export const TXORACLE_DEVNET = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const MS_PER_DAY = 86_400_000;

// A settlement predicate over 1-2 TxLINE stat legs. statKey = period*1000 + base (base 1/2 goals,
// 3/4 yellows, 5/6 reds, 7/8 corners); ScoreStat period 100 = game_finalised. op/cmp match the
// on-chain enums: op 0=Add 1=Subtract; cmp 0=GreaterThan 1=LessThan 2=EqualTo.
export interface PredicateSpec {
  leg0Key: number; leg0Period: number; leg1Key: number; leg1Period: number;
  op: number; cmp: number; threshold: number; nLegs: 1 | 2;
}
/** YES = home win: (goals_p1 - goals_p2) > 0, both at full-time (period 100). */
export const homeWin = (): PredicateSpec => ({ leg0Key: 1, leg0Period: 100, leg1Key: 2, leg1Period: 100, op: 1, cmp: 0, threshold: 0, nLegs: 2 });
/** YES = over `line` total goals: (goals_p1 + goals_p2) > floor(line). */
export const overGoals = (line: number): PredicateSpec => ({ leg0Key: 1, leg0Period: 100, leg1Key: 2, leg1Period: 100, op: 0, cmp: 0, threshold: Math.floor(line), nLegs: 2 });

const i32le = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; };
const u32le = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const i64le = (v: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return b; };

// ---- borsh writer for the validate_stat_v3 payload (StatValidationInputV3) ----
// Minimal, matches the on-chain wire types. Binary API fields are base64 (OpenAPI format:binary).
const b64 = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));
const to32 = (v: string | number[] | Uint8Array): Uint8Array => {
  const a = typeof v === "string" ? b64(v) : Uint8Array.from(v as number[]);
  if (a.length !== 32) throw new Error(`expected 32-byte hash, got ${a.length}`);
  return a;
};
interface RawProofNode { hash: string | number[]; isRightSibling: boolean }
const encNodes = (nodes: RawProofNode[] | undefined): Uint8Array => {
  const list = nodes ?? [];
  return concat([u32le(list.length), ...list.map((n) => concat([to32(n.hash), Uint8Array.of(n.isRightSibling ? 1 : 0)]))]);
};
const encStat = (s: { key: number; value: number; period: number }): Uint8Array => concat([u32le(s.key), i32le(s.value), i32le(s.period)]);

/** Shape a raw stat-validation-v3 response into the borsh StatValidationInputV3 the CPI expects. */
export function buildValidateStatPayload(val: {
  ts?: number; summary: { fixtureId: number; updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number }; eventStatsSubTreeRoot: string };
  subTreeProof?: RawProofNode[]; mainTreeProof?: RawProofNode[]; eventStatRoot: string;
  statsToProve: { stat: { key: number; value: number; period: number }; statProof?: RawProofNode[] }[];
  multiproof: { hashes?: RawProofNode[]; indices: number[] };
}): { payload: Uint8Array; epochDay: number; tsMs: number } {
  const tsMs = val.summary.updateStats.minTimestamp;
  const us = val.summary.updateStats;
  const payload = concat([
    i64le(BigInt(tsMs)),                                              // ts
    i64le(BigInt(val.summary.fixtureId)),                            // fixture_summary.fixture_id
    i32le(us.updateCount), i64le(BigInt(us.minTimestamp)), i64le(BigInt(us.maxTimestamp)), // update_stats
    to32(val.summary.eventStatsSubTreeRoot),                         // events_sub_tree_root
    encNodes(val.subTreeProof),                                       // fixture_proof
    encNodes(val.mainTreeProof),                                      // main_tree_proof
    to32(val.eventStatRoot),                                          // event_stat_root
    u32le(val.statsToProve.length),                                  // leaves (Vec)
    ...val.statsToProve.map((l) => concat([encStat(l.stat), encNodes(l.statProof)])),
    encNodes(val.multiproof.hashes),                                 // multiproof_hashes
    concat([u32le(val.multiproof.indices.length), ...val.multiproof.indices.map(u32le)]), // leaf_indices
  ]);
  return { payload, epochDay: Math.floor(tsMs / MS_PER_DAY), tsMs };
}

/** InitOutcome (disc 7): bind the settlement predicate + NO mint + payout + txoracle to a market.
 *  The book PDA must already be the mint authority of both YES(base) and NO. */
export function initOutcomeIx(args: {
  orderbook: PublicKey; marketId: bigint; authority: PublicKey;
  baseMint: PublicKey; noMint: PublicKey; oracleProgram: PublicKey;
  predicate: PredicateSpec; payout: bigint; rent: bigint;
}): TransactionInstruction {
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const [book] = bookPda(args.orderbook, args.marketId);
  const [res, resBump] = resPda(args.orderbook, args.marketId);
  const p = args.predicate;
  const data = concat([
    Uint8Array.of(INIT_OUTCOME), u64le(args.marketId), Uint8Array.of(resBump),
    u32le(p.leg0Key), i32le(p.leg0Period), u32le(p.leg1Key), i32le(p.leg1Period),
    Uint8Array.of(p.op), Uint8Array.of(p.cmp), i32le(p.threshold), Uint8Array.of(p.nLegs),
    u64le(args.payout), u64le(args.rent), args.oracleProgram.toBytes(),
  ]);
  return new TransactionInstruction({
    programId: args.orderbook,
    data,
    keys: [
      m(args.authority, true, true), m(res, false, true), m(cfg, false, false),
      m(args.baseMint, false, false), m(args.noMint, false, false), m(book, false, false),
      m(SystemProgram.programId, false, false),
    ],
  });
}

/** MintSet (disc 8): deposit `amount * payout` quote collateral, receive `amount` YES + `amount` NO.
 *  This funds redemptions — without an outstanding complete set there is nothing solvent to redeem. */
export function mintSetIx(args: {
  orderbook: PublicKey; marketId: bigint; user: PublicKey; amount: bigint;
  baseMint: PublicKey; noMint: PublicKey; quoteMint: PublicKey; quoteVault: PublicKey;
}): TransactionInstruction {
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const [res] = resPda(args.orderbook, args.marketId);
  const userQuote = getAssociatedTokenAddressSync(args.quoteMint, args.user, true);
  const userYes = getAssociatedTokenAddressSync(args.baseMint, args.user, true);
  const userNo = getAssociatedTokenAddressSync(args.noMint, args.user, true);
  const data = concat([Uint8Array.of(MINT_SET), u64le(args.marketId), Uint8Array.of(bump), u64le(args.amount)]);
  return new TransactionInstruction({
    programId: args.orderbook,
    data,
    keys: [
      m(args.user, true, true), m(book, false, false), m(cfg, false, false), m(res, false, false),
      m(userQuote, false, true), m(args.quoteVault, false, true),
      m(args.baseMint, false, true), m(args.noMint, false, true),
      m(userYes, false, true), m(userNo, false, true), m(TOKEN_PROGRAM, false, false),
    ],
  });
}

/** Resolve (disc 5): CPI txoracle validate_stat_v3 with the caller's proof `payload` + the market's
 *  stored predicate, then stamp the winning side. Trustless — the oracle checks the multiproof
 *  against its own published root. `payload`/`epochDay` come from buildValidateStatPayload().
 *  NOTE: validate_stat_v3 is compute-heavy (~1.4M CU) — prepend a ComputeBudget limit ix. */
export function resolveIx(args: {
  orderbook: PublicKey; marketId: bigint; caller: PublicKey; oracleProgram: PublicKey;
  payload: Uint8Array; epochDay: number;
}): TransactionInstruction {
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const [res] = resPda(args.orderbook, args.marketId);
  const [roots] = scoresRootPda(args.oracleProgram, args.epochDay);
  const data = concat([Uint8Array.of(RESOLVE), u64le(args.marketId), args.payload]);
  return new TransactionInstruction({
    programId: args.orderbook,
    data,
    keys: [
      m(args.caller, true, true), m(res, false, true), m(cfg, false, false),
      m(args.oracleProgram, false, false), m(roots, false, false),
    ],
  });
}

/** Redeem (disc 6): after Resolve, burn `amount` of the winning-side mint and collect
 *  `amount * payout` quote from the vault. Losing-side shares have no redemption path.
 *  `winningMint` is base (YES) if YES won, else the NO mint — read from the res account first. */
export function redeemIx(args: {
  orderbook: PublicKey; marketId: bigint; holder: PublicKey; amount: bigint;
  winningMint: PublicKey; quoteMint: PublicKey; quoteVault: PublicKey;
}): TransactionInstruction {
  const [book, bump] = bookPda(args.orderbook, args.marketId);
  const [cfg] = cfgPda(args.orderbook, args.marketId);
  const [res] = resPda(args.orderbook, args.marketId);
  const holderWin = getAssociatedTokenAddressSync(args.winningMint, args.holder, true);
  const holderQuote = getAssociatedTokenAddressSync(args.quoteMint, args.holder, true);
  const data = concat([Uint8Array.of(REDEEM), u64le(args.marketId), Uint8Array.of(bump), u64le(args.amount)]);
  return new TransactionInstruction({
    programId: args.orderbook,
    data,
    keys: [
      m(args.holder, true, true), m(book, false, false), m(cfg, false, false), m(res, false, true),
      m(args.winningMint, false, true), m(holderWin, false, true),
      m(args.quoteVault, false, true), m(holderQuote, false, true), m(TOKEN_PROGRAM, false, false),
    ],
  });
}

/** Read a resolution PDA's settled state (winning side + proven leg values), or null if
 *  unresolved/absent. Lets a REDEEM caller pick the winning mint. Offsets mirror R_* in lib.rs. */
export async function readResolution(
  reader: AccountReader, orderbook: PublicKey, marketId: bigint,
): Promise<{ resolved: boolean; yesWon: boolean; val0: number; val1: number } | null> {
  const [res] = resPda(orderbook, marketId);
  const d = await reader.accountData(res);
  if (!d || d.length < 110) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const R_RESOLVED = 100, R_WINNING = 101, R_VAL0 = 102, R_VAL1 = 106;
  return { resolved: d[R_RESOLVED] === 1, yesWon: d[R_WINNING] === 1, val0: dv.getInt32(R_VAL0, true), val1: dv.getInt32(R_VAL1, true) };
}
