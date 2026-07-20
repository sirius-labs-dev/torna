"use client";

// The "both worlds" panel for TornaFan: the live game above is on the World Cup final and fills as it
// plays; here is the same game already run to completion — France v England, scored round by round
// against TxLINE proofs, on-chain and verifiable right now. Polls, so a replay makes it re-rank live.
import { useCallback, useEffect, useState } from "react";
import { Trophy, ShieldCheck } from "lucide-react";

interface Row { player: string; score: number; streak: number }
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function ProvenFan() {
  const [board, setBoard] = useState<Row[]>([]);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetch("/api/fan/proven").then((x) => x.json());
      setBoard(d.leaderboard ?? []);
      setLastTx(d.lastTx ?? null);
    } catch { /* keep last */ }
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 5000); return () => clearInterval(id); }, [load]);

  return (
    <section className="mx-auto mt-8 max-w-2xl">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">See it in action — a game already played</h2>
        <p className="text-xs text-muted">The final above fills the same way, live, as it plays.</p>
      </div>
      <div className="rounded-2xl border border-bid/30 bg-bid/[0.04]">
        <div className="flex items-center justify-between border-b border-bid/20 px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><Trophy className="h-4 w-4 text-bid" aria-hidden /> France <span className="text-faint">vs</span> England · final standings</div>
          <span className="text-[11px] text-faint">on-chain · scored by TxLINE proofs</span>
        </div>
        {board.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-faint">loading the on-chain board…</div>
        ) : (
          board.map((r, i) => (
            <div key={r.player} className="flex items-center justify-between border-b border-bid/10 px-5 py-2.5 text-sm last:border-0">
              <div className="flex items-center gap-3">
                <span className={`nums w-5 text-right ${i === 0 ? "font-semibold text-bid" : "text-faint"}`}>{i + 1}</span>
                <span className="nums text-fg">{short(r.player)}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="nums text-muted">{r.streak}🔥</span>
                <span className="nums font-semibold text-fg">{r.score} pts</span>
              </div>
            </div>
          ))
        )}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-bid/20 px-5 py-2.5 text-[11px] text-faint">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-bid" aria-hidden />
          <span>Every round here was scored on-chain against a TxLINE proof — provably fair, no admin.</span>
          {lastTx && (
            <a href={`https://explorer.solana.com/tx/${lastTx}?cluster=devnet`} target="_blank" rel="noreferrer"
              className="font-medium text-bid underline decoration-dotted underline-offset-2 hover:text-fg">
              verify a round on-chain ↗
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
