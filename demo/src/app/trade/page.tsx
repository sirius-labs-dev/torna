import { Terminal } from "@/components/Terminal";
import { DevX } from "@/components/DevX";
import { SettlementPanel } from "@/components/SettlementPanel";
import { ProvenSettlement } from "@/components/ProvenSettlement";
import { isPredictionMarket } from "@/lib/market";

export default function TradePage() {
  const pred = isPredictionMarket();
  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      {/* short hero */}
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">On-chain prediction market · settled on TxLINE proofs</p>
        <h1 className="display mt-2 text-3xl font-semibold tracking-tight">TornaLine</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Trade a match outcome as a share, then let anyone settle the market trustlessly from a TxLINE
          proof — no admin, no oracle you have to trust. Built on Torna&apos;s parallel on-chain order book.
        </p>
      </div>

      {/* the market — the product, first */}
      {pred ? (
        <SettlementPanel />
      ) : (
        <Terminal />
      )}

      {/* both worlds: the live market above settles the same way — here it is already proven */}
      {pred && <ProvenSettlement />}

      {/* the CLOB under the hood (only shown as a secondary section on a prediction market) */}
      {pred && (
        <section className="mt-10">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Order book &amp; live trading</h2>
            <p className="text-xs text-muted">
              A real central limit order book on Torna — place, take, cancel are live devnet txs, read from the on-chain B+ tree. Price is the implied probability.
            </p>
          </div>
          <Terminal />
        </section>
      )}

      <div className="mt-12">
        <DevX />
      </div>
    </div>
  );
}
