import { Terminal } from "@/components/Terminal";
import { DevX } from "@/components/DevX";
import { SettlementPanel } from "@/components/SettlementPanel";
import { isPredictionMarket } from "@/lib/market";

export default function TradePage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">On-chain prediction markets, settled on TxLINE proofs — built on Torna</p>
        <h1 className="display mt-2 text-3xl font-semibold tracking-tight">TornaLine</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          TornaLine is an on-chain prediction market for live World Cup football. Outcome shares trade on a
          parallel central limit order book (Torna / TornaDEX) with real SPL-token escrow; when the match
          finishes, anyone settles the market trustlessly — TxLINE&apos;s txoracle verifies a Merkle proof of
          the result on-chain, with no trusted relayer. Place, take, cancel, mint, resolve, and redeem are
          real devnet transactions; the book is read straight from the on-chain B+ tree, with no indexer.
        </p>
      </div>

      <Terminal />

      {isPredictionMarket() && <SettlementPanel />}

      <div className="mt-12">
        <DevX />
      </div>
    </div>
  );
}
