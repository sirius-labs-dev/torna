"use client";

// Implied probability, two ways: the MARKET's own price (the CLOB mid, read from /api/book) and
// TxLINE's demargined consensus odds (from the odds feed). The market number is always live; the
// TxLINE consensus is live while the match is in play and "closed" once it finishes. This is the
// "Prediction Market Viewer" the track asks for: implied probabilities off the real-time feed.
import { useEffect, useState } from "react";

interface Outcome { name: string; prob: number | null }

export function ImpliedOdds({ fixtureId, home }: { fixtureId: number; home: string }) {
  const [mid, setMid] = useState<number | null>(null); // market implied %, from the CLOB mid
  const [consensus, setConsensus] = useState<number | null | undefined>(undefined); // TxLINE %, undefined=loading

  useEffect(() => {
    let alive = true;
    // market: mid of the on-chain book (price is already a 0–100 probability)
    fetch("/api/book", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        const ask = j.asks?.[0]?.price != null ? Number(j.asks[0].price) : undefined;
        const bid = j.bids?.[0]?.price != null ? Number(j.bids[0].price) : undefined;
        setMid(ask != null && bid != null ? Math.round((ask + bid) / 2) : (bid ?? ask ?? null));
      })
      .catch(() => alive && setMid(null));

    // TxLINE consensus: demargined home-win probability ("1" in a 1X2 market)
    if (!fixtureId) { setConsensus(null); return; }
    fetch(`/api/txline/odds/${fixtureId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { outcomes?: Outcome[] } | null) => {
        if (!alive) return;
        const o = j?.outcomes?.find((x) => x.name === "1") ?? j?.outcomes?.[0];
        setConsensus(o?.prob != null ? Math.round(o.prob * 100) : null);
      })
      .catch(() => alive && setConsensus(null));

    return () => { alive = false; };
  }, [fixtureId]);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-bg-soft px-3.5 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Implied probability · {home} to win</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] text-faint">Market</span>
        <span className="nums text-lg font-semibold text-brand">{mid != null ? `${mid}%` : "—"}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] text-faint">TxLINE consensus</span>
        <span className="nums text-base font-medium text-fg">
          {consensus === undefined ? "…" : consensus === null ? "— closed" : `${consensus}%`}
        </span>
      </div>
      <span className="hidden text-[11px] text-faint sm:inline">CLOB mid vs TxLINE’s demargined odds</span>
    </div>
  );
}
