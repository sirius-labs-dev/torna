// The "both worlds" card: the live market above settles the same way at full time — and here it is
// already proven, on a completed match. France v England is permanently settled on-chain, so a judge
// can verify the settlement mechanism *right now* without waiting for the final to end.
import { ShieldCheck } from "lucide-react";
import { explorerTx, explorerAddr } from "@/lib/market";

// permanent devnet settlement of the France v England prediction market (market 3).
const SETTLED = {
  home: "France",
  away: "England",
  score: "4–6",
  outcome: "France did not win",
  resolveTx: "4hH3Wg9p9wQXqe2jGL3Mm3ELRTAwwHEdcAqkp9NhJvF4SdCT9PhKuhpxYUdFd6AoxRnNLfTDFXfTvMt2CAKSekMb",
  resAccount: "HCAbzJ7dDp33c513FAWLPiEPi1YcvtRyycamcbc3LvZq",
  oracleProgram: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
};

export function ProvenSettlement() {
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">Settlement, already proven</h2>
        <p className="text-xs text-muted">
          The live market above settles the exact same way at full time. Here it is already done — on a
          completed match, verifiable right now.
        </p>
      </div>
      <div className="rounded-2xl border border-bid/30 bg-bid/[0.04] p-5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-bid">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Settlement receipt · verifiable
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-base font-semibold text-fg">{SETTLED.home} <span className="text-faint">vs</span> {SETTLED.away}</span>
          <span className="nums text-sm text-muted">full time {SETTLED.score}</span>
          <span className="rounded-full border border-bid/40 bg-bid/10 px-2 py-0.5 text-[11px] font-medium text-bid">SETTLED · NO won · {SETTLED.score}</span>
        </div>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-muted">
          <span className="text-fg">{SETTLED.outcome}.</span> Proven from TxLINE&apos;s on-chain scores root and verified by
          txoracle <code className="text-faint">validate_stat_v3</code> — no admin, no trusted relayer. Anyone can re-check it on-chain:
        </p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a className="text-brand underline hover:text-brand-hi" href={explorerTx(SETTLED.resolveTx)} target="_blank" rel="noreferrer">resolve transaction ↗</a>
          <a className="text-brand underline hover:text-brand-hi" href={explorerAddr(SETTLED.resAccount)} target="_blank" rel="noreferrer">resolution account ↗</a>
          <a className="text-muted hover:text-fg" href={explorerAddr(SETTLED.oracleProgram)} target="_blank" rel="noreferrer">txoracle program ↗</a>
        </div>
      </div>
    </section>
  );
}
