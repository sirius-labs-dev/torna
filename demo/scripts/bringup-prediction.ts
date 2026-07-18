// Devnet PREDICTION-MARKET bring-up. A superset of bringup.ts: same trees/vaults/InitMarket, but
// base == a YES share whose mint authority is the book PDA (so MINT_SET is the only minter), plus a
// NO mint (same authority), plus InitOutcome binding a TxLINE fixture + the outcome YES pays on.
// Liquidity is seeded the honest way — demos MINT_SET a complete set (deposit quote collateral ->
// YES+NO), then place YES orders — so the quote vault is always solvent for redemptions.
//
// Coexists with the plain CLOB demo (uses MARKET_ID=2). Writes src/lib/market.json (with the
// `prediction` block) + .env.local, so the UI settles on THIS market.
//
// Run from demo/:  npx tsx scripts/bringup-prediction.ts
import "../src/lib/polyfill";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { Tree, keys, type AccountReader } from "torna-sdk";
import {
  ASK, BID, bookPda, cfgPda, resPda, orderValue, transferAuthorityIx, initMarketIx,
  initOutcomeIx, mintSetIx, placeIx, homeWin, TXORACLE_DEVNET, type Side, type PredicateSpec,
} from "../src/lib/orderbook";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const VS = 8 + 32; // 40: maker(32) + size_be(8)
const F = 8;
const MARKET_ID = 3n; // distinct from the plain CLOB demo (market 1)
const ASK_TREE = 5;
const BID_TREE = 6;

// --- the bet this market settles ---
const FIXTURE_ID = BigInt(process.env.FIXTURE_ID ?? "0"); // set to a real World Cup fixtureId
const PREDICATE: PredicateSpec = homeWin();               // YES = home win (goals P1 - P2 > 0 @ FT)
const OUTCOME_LABEL = "Home win";
const STAT_KEYS = [1, 2];                                 // leg order: goals P1, goals P2
const PAYOUT = 1n; // quote units per winning share (decimals 0 -> 1 == 1 whole unit)

const conn = new Connection(RPC, "confirmed");
const here = (p: string) => join(import.meta.dirname, p);
function loadKp(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const reader: AccountReader = {
  async accountData(k: PublicKey) {
    const a = await conn.getAccountInfo(k, "confirmed");
    return a ? Uint8Array.from(a.data) : null;
  },
};
const rent = (n: number) => conn.getMinimumBalanceForRentExemption(n);
async function send(ixs: any[], signers: Keypair[]): Promise<string> {
  return sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
}
function nodeSize(f: number, vs: number): number {
  return Math.max(44 + (f + 1) * 32 + (f + 1) * vs, 44 + (f + 1) * 32 + (f + 2) * 8);
}

async function main() {
  const payer = loadKp(process.env.WALLET_KEYPAIR || join(homedir(), ".config/solana/id.json"));
  const torna = process.env.TORNA_PROGRAM ? new PublicKey(process.env.TORNA_PROGRAM) : loadKp(here("../deploy/torna-keypair.json")).publicKey;
  const orderbook = process.env.ORDERBOOK_PROGRAM ? new PublicKey(process.env.ORDERBOOK_PROGRAM) : loadKp(here("../deploy/orderbook-keypair.json")).publicKey;
  const [book, bump] = bookPda(orderbook, MARKET_ID);
  const [cfg] = cfgPda(orderbook, MARKET_ID);
  const [res] = resPda(orderbook, MARKET_ID);
  const ask = new Tree(torna, payer.publicKey, ASK_TREE);
  const bid = new Tree(torna, payer.publicKey, BID_TREE);
  console.log("orderbook", orderbook.toBase58(), "book", book.toBase58());

  if (await reader.accountData(ask.headerPda()[0])) {
    console.error(`market ${MARKET_ID} already initialized. Bump MARKET_ID/tree ids for a fresh one. Aborting.`);
    process.exit(1);
  }

  // 1) mints. quote (USDC-like collateral, payer authority = demo faucet). YES(base) + NO have the
  //    BOOK PDA as mint authority so ONLY MINT_SET can create shares.
  console.log("creating mints (YES/NO authority = book PDA) ...");
  const quoteMint = await createMint(conn, payer, payer.publicKey, null, 0);
  const baseMint = await createMint(conn, payer, book, null, 0); // YES
  const noMint = await createMint(conn, payer, book, null, 0);   // NO

  // 2) vaults = the book PDA's ATAs
  const baseVault = (await getOrCreateAssociatedTokenAccount(conn, payer, baseMint, book, true)).address;
  const quoteVault = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, book, true)).address;

  // 3) trees: init, seed a 0-size sentinel, authority -> book PDA
  const rHdr = BigInt(await rent(146));
  const rAlloc = BigInt(await rent(32));
  const rNode = BigInt(await rent(nodeSize(F, VS)));
  for (const [tree, side, sentPrice] of [[ask, ASK, 1_000_000n], [bid, BID, 1n]] as [Tree, Side, bigint][]) {
    console.log(`init tree ${tree.treeId} ...`);
    await send([tree.initTreeIx(payer.publicKey, VS, F, rHdr, rAlloc)], [payer]);
    const sd = side === ASK ? keys.Side.Ask : keys.Side.Bid;
    const cold = await tree.insertIx(reader, payer.publicKey,
      keys.orderKey(sd, sentPrice, 0n, payer.publicKey, 0n), orderValue(payer.publicKey, 0n), rNode);
    if (!cold) throw new Error("sentinel cold insert ix unresolved");
    await send([cold], [payer]);
    await send([transferAuthorityIx(torna, tree.headerPda()[0], payer.publicKey, book)], [payer]);
  }

  // 4) InitMarket
  console.log("init market ...");
  const askRoot = ask.nodePda((await ask.header(reader))!.root)[0];
  const bidRoot = bid.nodePda((await bid.header(reader))!.root)[0];
  await send([initMarketIx({
    orderbook, torna, marketId: MARKET_ID, payer: payer.publicKey,
    baseMint, quoteMint, baseVault, quoteVault,
    askHeader: ask.headerPda()[0], bidHeader: bid.headerPda()[0], askRoot, bidRoot,
    rent: BigInt(await rent(229)),
  })], [payer]);

  // 5) InitOutcome: bind the predicate + NO mint + payout + txoracle to the market
  console.log(`init outcome (fixture ${FIXTURE_ID}, "${OUTCOME_LABEL}", payout ${PAYOUT}) ...`);
  await send([initOutcomeIx({
    orderbook, marketId: MARKET_ID, authority: payer.publicKey,
    baseMint, noMint, oracleProgram: TXORACLE_DEVNET,
    predicate: PREDICATE, payout: PAYOUT, rent: BigInt(await rent(110)),
  })], [payer]);
  console.log("res PDA", res.toBase58());

  // 6) demo identities: SOL + quote (collateral). YES/NO come only from MINT_SET.
  console.log("funding demos + minting complete sets ...");
  const demos = Array.from({ length: 4 }, () => Keypair.generate());
  const quoteAtaOf: Record<string, PublicKey> = {};
  for (const kp of demos) {
    await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 30_000_000 })], [payer]);
    // ATAs must exist before MINT_SET / trading
    quoteAtaOf[kp.publicKey.toBase58()] = (await getOrCreateAssociatedTokenAccount(conn, payer, quoteMint, kp.publicKey)).address;
    await getOrCreateAssociatedTokenAccount(conn, payer, baseMint, kp.publicKey); // YES ATA
    await getOrCreateAssociatedTokenAccount(conn, payer, noMint, kp.publicKey);   // NO ATA
    // give them quote: 500 for collateral + 500 for buying YES on the book
    await mintTo(conn, payer, quoteMint, quoteAtaOf[kp.publicKey.toBase58()], payer, 10000);
    // MINT_SET 200 sets -> 200 YES + 200 NO (deposits 200 quote collateral)
    await send([mintSetIx({ orderbook, marketId: MARKET_ID, user: kp.publicKey, amount: 200n, baseMint, noMint, quoteMint, quoteVault })], [payer, kp]);
  }

  // 7) seed a YES order book: asks sell YES for quote, bids buy YES with quote. Prices in [1..99]
  //    read as an implied probability of "home win" (out of 100).
  console.log("seeding YES order book ...");
  const seed: [number, Side, bigint, bigint][] = [
    [0, ASK, 62n, 30n], [1, ASK, 65n, 40n], [2, ASK, 68n, 25n],
    [0, BID, 58n, 35n], [1, BID, 55n, 20n], [3, BID, 52n, 30n],
  ];
  for (const [mi, side, price, size] of seed) {
    const maker = demos[mi];
    const tree = side === ASK ? ask : bid;
    // ASK escrows YES(base); BID escrows quote
    const src = side === ASK
      ? (await getOrCreateAssociatedTokenAccount(conn, payer, baseMint, maker.publicKey)).address
      : quoteAtaOf[maker.publicKey.toBase58()];
    const vault = side === ASK ? baseVault : quoteVault;
    const { ix } = await placeIx({
      reader, tree, orderbook, torna, marketId: MARKET_ID,
      side, price, size, nonce: BigInt(mi + 1), maker: maker.publicKey, makerSrc: src, vault,
    });
    await send([ix], [payer, maker]);
    console.log(`  ${side === ASK ? "ASK" : "BID"} ${size} YES @ ${price} by demo${mi}`);
  }

  // 8) frontend config (with the prediction block)
  const market = {
    cluster: "devnet", rpcUrl: "https://api.devnet.solana.com",
    tornaProgramId: torna.toBase58(), orderbookProgramId: orderbook.toBase58(),
    marketId: MARKET_ID.toString(), bookBump: bump,
    creator: payer.publicKey.toBase58(), askTreeId: ASK_TREE, bidTreeId: BID_TREE,
    baseMint: baseMint.toBase58(), quoteMint: quoteMint.toBase58(),
    baseVault: baseVault.toBase58(), quoteVault: quoteVault.toBase58(),
    book: book.toBase58(), cfg: cfg.toBase58(),
    demos: demos.map((k) => ({ pubkey: k.publicKey.toBase58(), secret: Array.from(k.secretKey) })),
    prediction: {
      noMint: noMint.toBase58(), fixtureId: FIXTURE_ID.toString(),
      oracleProgram: TXORACLE_DEVNET.toBase58(), payout: PAYOUT.toString(),
      label: OUTCOME_LABEL, statKeys: STAT_KEYS,
    },
  };
  writeFileSync(here("../src/lib/market.json"), JSON.stringify(market, null, 2));
  console.log("\nDONE. wrote src/lib/market.json (prediction market", MARKET_ID.toString(), ")");
  console.log("Set FIXTURE_ID to a real World Cup fixture before the live demo.");
}

main().catch((e) => { console.error(e); process.exit(1); });
