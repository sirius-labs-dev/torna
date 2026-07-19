import Link from "next/link";
import { ArrowRight, BarChart3, Code2, Compass, FileText } from "lucide-react";
import { GithubIcon } from "@/components/ui/GithubIcon";
import { LiveMarket } from "@/components/LiveMarket";

const GH = "https://github.com/nzengi/torna";

export default function Home() {
  return (
    <>
      {/* TornaLine: the product (hackathon), first */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="hero-glow pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <div className="mx-auto max-w-3xl px-6 pt-24 pb-16 text-center">
          <p className="enter text-xs font-semibold uppercase tracking-[0.2em] text-brand">On-chain prediction markets · settled on TxLINE proofs</p>
          <h1 className="enter display mt-4 text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Call the match. <span className="text-gradient">Settle on the proof</span>.
          </h1>
          <p className="enter mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted" style={{ animationDelay: "70ms" }}>
            <span className="font-medium text-fg">TornaLine</span> is an on-chain prediction market for live World Cup
            football. Trade outcome shares on a parallel order book; when the match ends, anyone settles the market
            trustlessly — TxLINE’s oracle verifies a Merkle proof of the result on-chain, with no admin and no trusted relayer.
          </p>
          <div className="enter mt-8 flex flex-wrap items-center justify-center gap-3" style={{ animationDelay: "140ms" }}>
            <Link href="/trade" className="inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-onbrand transition-colors duration-100 hover:bg-brand-hi active:translate-y-px">
              Open the live market <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <a href="https://explorer.solana.com/tx/4hH3Wg9p9wQXqe2jGL3Mm3ELRTAwwHEdcAqkp9NhJvF4SdCT9PhKuhpxYUdFd6AoxRnNLfTDFXfTvMt2CAKSekMb?cluster=devnet" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-line bg-panel px-5 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px">
              See a real settlement
            </a>
          </div>
          <p className="mt-5 text-xs text-faint">TxODDS World Cup Hackathon · live on devnet · built on Torna, the parallel on-chain order book</p>
        </div>
      </section>

      {/* How it works — the settlement core (the track is "...and Settlement") */}
      <section className="border-b border-line bg-bg-soft">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Prediction markets, and settlement</p>
            <h2 className="display mt-2 text-3xl font-semibold tracking-tight">Settled by proof, not by trust</h2>
            <p className="mx-auto mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
              The hard part of a sports market isn&apos;t the trading — it&apos;s who decides the result.
              TornaLine settles it on-chain, from a cryptographic proof of TxLINE&apos;s match data.
            </p>
          </div>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              { n: "1", t: "Trade the outcome", d: "Buy or sell a YES share on the parallel order book. Its price is the implied probability of the outcome." },
              { n: "2", t: "Anyone settles on the proof", d: "When the match ends, anyone triggers settlement — the program verifies a TxLINE Merkle proof of the result on-chain. No admin, no oracle you have to trust." },
              { n: "3", t: "Winners redeem", d: "The winning side redeems each share from the vault, one-for-one — and the whole outcome stays re-checkable on-chain." },
            ].map((s) => (
              <div key={s.n} className="rounded-xl border border-line bg-panel p-5">
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-brand/40 bg-brand/5 text-sm font-semibold text-brand">{s.n}</div>
                <h3 className="mt-3 text-sm font-semibold text-fg">{s.t}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.d}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Link href="/trade" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand-hi">Open the live market <ArrowRight className="h-4 w-4" aria-hidden /></Link>
          </div>
        </div>
      </section>

      {/* Under the hood: the order book TornaLine trades on */}
      <section className="border-y border-line bg-bg-soft">
        <div className="mx-auto max-w-6xl px-6 py-16 lg:grid lg:grid-cols-2 lg:items-center lg:gap-12">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">Under the hood</div>
            <h2 className="display mt-2 text-3xl font-semibold tracking-tight">A real order book, live on devnet</h2>
            <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted">
              TornaLine trades on a central limit order book with real SPL-token escrow; place, take, cancel,
              and match are real on-chain transactions, read straight from the on-chain B+ tree — no indexer.
              Every price level is its own account, so a burst of orders on a goal commits in parallel — the
              write concurrency a live football market needs. (That engine is Torna.)
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <Link href="/trade" className="inline-flex items-center gap-1.5 font-medium text-brand hover:text-brand-hi">Open the live market <ArrowRight className="h-3.5 w-3.5" aria-hidden /></Link>
              <Link href="/explorer" className="text-muted hover:text-fg">Inspect the on-chain trees</Link>
            </div>
          </div>
          <div className="mt-8 lg:mt-0"><LiveMarket /></div>
        </div>
      </section>

      {/* Explore */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="display text-center text-2xl font-semibold tracking-tight">Go deeper</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Code2, t: "Build", d: "A code-first guide, TypeScript or Rust.", href: "/build" },
            { icon: FileText, t: "Docs", d: "The primitive and the reference app, in full.", href: "/docs" },
            { icon: BarChart3, t: "Research", d: "Motivation, the model, and the measured numbers.", href: "/research" },
            { icon: Compass, t: "Explorer", d: "Decode the live on-chain trees and transactions.", href: "/explorer" },
          ].map((c) => (
            <Link key={c.t} href={c.href} className="group rounded-xl border border-line bg-panel p-5 transition-colors duration-150 hover:border-brand/40">
              <c.icon className="h-5 w-5 text-brand" aria-hidden />
              <div className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-fg">{c.t} <ArrowRight className="h-3.5 w-3.5 -translate-x-1 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100" aria-hidden /></div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">{c.d}</p>
            </Link>
          ))}
        </div>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted">
          <a href={GH} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-brand"><GithubIcon className="h-4 w-4" /> GitHub</a>
          <a href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer" className="hover:text-brand">torna-sdk on npm</a>
          <a href="https://crates.io/crates/torna-sdk" target="_blank" rel="noreferrer" className="hover:text-brand">torna-sdk on crates.io</a>
          <code className="nums rounded border border-line bg-panel px-2.5 py-1 text-xs text-muted">npm i torna-sdk</code>
        </div>
      </section>
    </>
  );
}
