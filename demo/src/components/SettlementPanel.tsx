"use client";

// Prediction-market settlement panel: the live TxLINE score strip, the outcome YES pays on, the
// on-chain resolution status, and the three settlement actions (mint a complete set, resolve from
// the TxLINE proof, redeem the winning side). Renders only on a market brought up with a
// prediction/settlement layer (bringup-prediction.ts); a plain CLOB market shows nothing.
import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Coins, Gavel, Trophy } from "lucide-react";
import { mintSet, resolve, redeem, keypairActor, walletActor, type Actor } from "@/lib/actions";
import { useTxlineStream } from "@/lib/txline/useTxlineStream";
import {
  MARKET, connection, demoKeypair, explorerTx, marketId, orderbookProgram, prediction, reader,
} from "@/lib/market";
import { readResolution } from "@/lib/orderbook";

interface LiveScore { scoreSoccer?: { p1: number; p2: number }; score?: { p1: number; p2: number }; gameState?: string; action?: string }
const p1p2 = (s: LiveScore | null): [number, number] | null => {
  const sc = s?.scoreSoccer ?? s?.score;
  return sc ? [sc.p1, sc.p2] : null;
};

type Resolution = { resolved: boolean; yesWon: boolean; val0: number; val1: number } | null;

export function SettlementPanel() {
  const wallet = useWallet();
  const [demoIdx, setDemoIdx] = useState(0);
  const [amount, setAmount] = useState("50");
  const [msg, setMsg] = useState<{ text: string; sig?: string } | null>(null);
  const [busy, setBusy] = useState<"mint" | "resolve" | "redeem" | null>(null);
  const [res, setRes] = useState<Resolution>(null);

  // Guard is at the parent (rendered only when isPredictionMarket()); prediction() is safe here.
  const pred = prediction();
  const fixtureId = Number(pred.fixtureId);
  const { last, connected: streaming } = useTxlineStream<LiveScore>("scores", fixtureId || null);
  const live = p1p2(last);

  // poll the on-chain resolution status
  const loadRes = useCallback(async () => {
    try { setRes(await readResolution(reader(connection()), orderbookProgram(), marketId())); } catch { /* ignore */ }
  }, []);
  useEffect(() => { loadRes(); const id = setInterval(loadRes, 10_000); return () => clearInterval(id); }, [loadRes]);

  const actor: Actor | null = (() => {
    try {
      if (wallet.connected && wallet.publicKey) return walletActor(wallet.publicKey, wallet.sendTransaction);
      if (MARKET.demos[demoIdx]?.secret) return keypairActor(demoKeypair(demoIdx));
    } catch { /* fall through */ }
    return null;
  })();

  const run = async (kind: "mint" | "resolve" | "redeem", fn: () => Promise<{ sig: string } | string>) => {
    if (!actor || busy) return;
    setBusy(kind);
    setMsg({ text: `${kind}…` });
    try {
      const r = await fn();
      const sig = typeof r === "string" ? r : r.sig;
      setMsg({ text: `${kind} confirmed`, sig });
      loadRes();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const amt = () => { const n = BigInt(Math.max(0, Math.floor(Number(amount) || 0))); if (n === 0n) throw new Error("enter an amount"); return n; };
  const badge = res?.resolved
    ? { text: `SETTLED · ${res.yesWon ? "YES" : "NO"} won · ${res.val0}–${res.val1}`, cls: "border-bid/50 bg-bid/10 text-bid" }
    : { text: "OPEN · awaiting full-time", cls: "border-line bg-panel-hi text-muted" };

  return (
    <div className="mt-6 rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">TornaLine · prediction market settlement</div>
          <div className="mt-1 text-base font-semibold tracking-tight">
            YES = <span className="text-brand">{pred.label}</span>
            <span className="ml-2 text-xs font-normal text-faint">fixture {pred.fixtureId} · payout {pred.payout} quote/share</span>
          </div>
        </div>
        {/* live TxLINE score */}
        <div className="flex items-center gap-2 rounded-lg border border-line bg-bg-soft px-3 py-2">
          <span className={`h-2 w-2 rounded-full ${streaming ? "bg-bid" : "bg-faint"}`} aria-hidden />
          <span className="nums text-sm text-fg">{live ? `${live[0]} – ${live[1]}` : "– – –"}</span>
          <span className="text-[11px] text-faint">{last?.gameState ?? (fixtureId ? "live score" : "set FIXTURE_ID")}</span>
        </div>
        <span className={`ml-auto rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${badge.cls}`}>{badge.text}</span>
      </div>

      {/* acting identity (compact) */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-faint">Act as</span>
        {!wallet.connected && MARKET.demos.map((d, i) => (
          <button key={d.pubkey} onClick={() => setDemoIdx(i)} aria-pressed={i === demoIdx}
            className={`rounded-lg border px-2.5 py-1 text-xs transition-colors duration-100 active:translate-y-px ${i === demoIdx ? "border-brand bg-brand/5 text-fg" : "border-line text-muted hover:border-muted"}`}>
            Trader {i + 1}
          </button>
        ))}
        {wallet.connected && <span className="rounded-lg border border-line bg-bg-soft px-2.5 py-1 text-xs text-fg">your wallet</span>}
        <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric"
          aria-label="share amount"
          className="ml-2 w-24 rounded-lg border border-line bg-bg-soft px-2.5 py-1 text-sm text-fg outline-none focus:border-brand" />
        <span className="text-[11px] text-faint">shares</span>
      </div>

      {/* the three settlement actions */}
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <button onClick={() => run("mint", () => mintSet(actor!, amt()))} disabled={!actor || busy !== null}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2.5 text-sm font-medium text-brand transition-colors duration-100 hover:bg-brand/10 active:translate-y-px disabled:pointer-events-none disabled:opacity-40">
          <Coins className="h-4 w-4" aria-hidden /> {busy === "mint" ? "Minting…" : "Mint complete set"}
        </button>
        <button onClick={() => run("resolve", () => resolve(actor!))} disabled={!actor || busy !== null || res?.resolved}
          title={res?.resolved ? "already settled" : "settle from the TxLINE score proof"}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-panel-hi px-3 py-2.5 text-sm font-medium text-fg transition-colors duration-100 hover:border-muted active:translate-y-px disabled:pointer-events-none disabled:opacity-40">
          <Gavel className="h-4 w-4" aria-hidden /> {busy === "resolve" ? "Resolving…" : "Resolve (proof)"}
        </button>
        <button onClick={() => run("redeem", () => redeem(actor!, amt()))} disabled={!actor || busy !== null || !res?.resolved}
          title={res?.resolved ? "redeem winning shares" : "available after settlement"}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-bid/40 bg-bid/5 px-3 py-2.5 text-sm font-medium text-bid transition-colors duration-100 hover:bg-bid/10 active:translate-y-px disabled:pointer-events-none disabled:opacity-40">
          <Trophy className="h-4 w-4" aria-hidden /> {busy === "redeem" ? "Redeeming…" : "Redeem winnings"}
        </button>
      </div>

      {msg && (
        <p role="status" aria-live="polite" className="mt-3 border-t border-line pt-3 text-xs text-muted">
          {msg.text}
          {msg.sig && <> · <a className="text-brand underline hover:text-brand-hi" href={explorerTx(msg.sig)} target="_blank" rel="noreferrer">view transaction</a></>}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-faint">
        Mint deposits <span className="nums">{pred.payout}</span> quote per set and returns equal YES + NO. Trade YES on the
        book above; its price is the implied probability of “{pred.label}”. Resolve verifies the final score
        against TxLINE’s on-chain root — the outcome comes from the proof, not from whoever clicks.
      </p>
    </div>
  );
}
