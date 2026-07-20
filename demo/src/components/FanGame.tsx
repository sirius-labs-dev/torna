"use client";

// TornaFan — the fan-facing Hi-Lo game. Tap Higher/Lower on the next match stat, build a streak,
// climb a live on-chain leaderboard (read from a Torna tree, re-sorted each poll). Provably fair:
// rounds are scored against a TxLINE proof on-chain, so no one can rig the board.
import { useCallback, useEffect, useState } from "react";
import { ArrowUp, ArrowDown, ShieldCheck, Trophy } from "lucide-react";
import { placePick } from "@/lib/fan-actions";
import { FAN, STAT_LABEL } from "@/lib/fan";

interface Row { player: string; score: number; streak: number }
interface Round { roundId: number; statKey: number; prevValue: number; lastOutcome: "higher" | "lower" | null; lastRound?: number; lastTx?: string | null; pickedBy?: string[] }

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function FanGame() {
  const [board, setBoard] = useState<Row[]>([]);
  const [round, setRound] = useState<Round | null>(null);
  const [me, setMe] = useState(0); // demo player index
  const [busy, setBusy] = useState<0 | 1 | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const stat = FAN.statLabel ?? STAT_LABEL[FAN.statKey] ?? "the stat";
  const matchup = FAN.home && FAN.away ? `${FAN.home} vs ${FAN.away}` : `fixture ${FAN.fixtureId}`;

  const load = useCallback(async () => {
    try {
      const [lb, r] = await Promise.all([
        fetch("/api/leaderboard").then((x) => x.json()),
        fetch("/api/fan/round").then((x) => x.json()),
      ]);
      setBoard(lb.leaderboard ?? []);
      if (!r.error) setRound(r);
    } catch { /* keep last */ }
  }, []);
  useEffect(() => { load(); const id = setInterval(() => { if (!document.hidden) load(); }, 5000); return () => clearInterval(id); }, [load]);

  const meKey = FAN.players[me]?.pubkey;
  const myRow = board.find((b) => b.player === meKey);
  const alreadyPicked = !!(meKey && round?.pickedBy?.includes(meKey));

  const tap = async (dir: 0 | 1) => {
    if (busy !== null || !round || alreadyPicked) return;
    setBusy(dir);
    setMsg(dir ? "calling HIGHER…" : "calling LOWER…");
    try {
      await placePick(FAN.players[me].secret, round.roundId, dir);
      setMsg(`locked in ${dir ? "HIGHER" : "LOWER"} for round ${round.roundId}`);
      load();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // a repeat call reverts as custom program error 0x0 ("already picked") — show the real state
      setMsg(/0x0|already/i.test(raw) ? `you already called round ${round.roundId} — waiting for the next update` : raw.slice(0, 120));
      load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* the question */}
      <div className="rounded-2xl border border-line bg-panel p-6 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">World Cup · {matchup} · round {round?.roundId ?? "—"}</div>
        <h2 className="display mt-2 text-2xl font-semibold tracking-tight">
          Will <span className="text-brand">{stat}</span> go higher before the next update?
        </h2>
        <p className="mt-1 text-sm text-muted">Currently {round?.prevValue ?? "—"}. Call it, build a streak, climb the board.</p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button onClick={() => tap(1)} disabled={busy !== null || alreadyPicked}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-bid/50 bg-bid/10 py-5 text-lg font-semibold text-bid transition-colors duration-100 hover:bg-bid/20 active:translate-y-px disabled:opacity-40">
            <ArrowUp className="h-6 w-6" aria-hidden /> {busy === 1 ? "…" : "Higher"}
          </button>
          <button onClick={() => tap(0)} disabled={busy !== null || alreadyPicked}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-ask/50 bg-ask/10 py-5 text-lg font-semibold text-ask transition-colors duration-100 hover:bg-ask/20 active:translate-y-px disabled:opacity-40">
            <ArrowDown className="h-6 w-6" aria-hidden /> {busy === 0 ? "…" : "Lower"}
          </button>
        </div>
        {/* act as (demo players) */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
          <span className="text-faint">playing as</span>
          {FAN.players.map((p, i) => (
            <button key={p.pubkey} onClick={() => setMe(i)} aria-pressed={i === me}
              className={`rounded-lg border px-2.5 py-1 transition-colors duration-100 ${i === me ? "border-brand bg-brand/5 text-fg" : "border-line text-muted hover:border-muted"}`}>
              Fan {i + 1}{myRow && i === me ? ` · ${myRow.streak}🔥` : ""}
            </button>
          ))}
        </div>
        {alreadyPicked
          ? <p className="mt-3 text-xs text-bid" role="status" aria-live="polite">✓ You called round {round?.roundId} — waiting for the next update.</p>
          : msg && <p className="mt-3 text-xs text-muted" role="status" aria-live="polite">{msg}</p>}
      </div>

      {/* live leaderboard */}
      <div className="rounded-2xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold"><Trophy className="h-4 w-4 text-brand" aria-hidden /> Live leaderboard</div>
          <span className="text-[11px] text-faint">on-chain · updates every round</span>
        </div>
        {board.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-faint">No scores yet — be the first to call it.</div>
        ) : (
          board.map((r, i) => (
            <div key={r.player} className={`flex items-center justify-between border-b border-line/60 px-5 py-2.5 text-sm last:border-0 ${r.player === meKey ? "bg-brand/5" : ""}`}>
              <div className="flex items-center gap-3">
                <span className={`nums w-5 text-right ${i === 0 ? "text-brand font-semibold" : "text-faint"}`}>{i + 1}</span>
                <span className="nums text-fg">{short(r.player)}{r.player === meKey ? " (you)" : ""}</span>
              </div>
              <div className="flex items-center gap-4">
                <span className="nums text-muted">{r.streak}🔥</span>
                <span className="nums font-semibold text-fg">{r.score} pts</span>
              </div>
            </div>
          ))
        )}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-line px-5 py-2.5 text-[11px] text-faint">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-bid" aria-hidden />
          <span>Provably fair: every round is scored against a TxLINE proof on-chain — no admin can rig the board. Built on Torna&apos;s parallel index.</span>
          {round?.lastTx && (
            <a href={`https://explorer.solana.com/tx/${round.lastTx}?cluster=devnet`} target="_blank" rel="noreferrer"
              className="font-medium text-bid underline decoration-dotted underline-offset-2 hover:text-fg">
              verify round {round.lastRound ?? ""} on-chain ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
