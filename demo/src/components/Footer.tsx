import { MARKET } from "@/lib/market";
import fan from "@/lib/fan.json";
import { Address } from "./ui/Address";
import { GithubIcon } from "./ui/GithubIcon";

export function Footer({ fanMode = false }: { fanMode?: boolean }) {
  // the on-chain addresses are product-specific: the fan game exposes its game + leaderboard PDAs,
  // the market exposes its order book + market config. The Torna engine is shared by both.
  const addrs = fanMode
    ? [
        { label: "engine", value: fan.tornaProgramId },
        { label: "game", value: fan.game },
        { label: "leaderboard", value: fan.lb },
      ]
    : [
        { label: "engine", value: MARKET.tornaProgramId },
        { label: "book", value: MARKET.orderbookProgramId },
        { label: "market", value: MARKET.cfg },
      ];
  return (
    <footer className="mt-10 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-8 text-xs text-faint sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a href="https://github.com/nzengi/torna" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium text-fg transition-colors duration-100 hover:text-brand">
              <GithubIcon className="h-4 w-4" /> GitHub
            </a>
            <a href="https://www.npmjs.com/package/torna-sdk" target="_blank" rel="noreferrer" className="font-medium text-fg transition-colors duration-100 hover:text-brand">torna-sdk (npm)</a>
            <a href="https://crates.io/crates/torna-sdk" target="_blank" rel="noreferrer" className="font-medium text-fg transition-colors duration-100 hover:text-brand">torna-sdk (crates.io)</a>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {addrs.map((a) => (
              <span key={a.label} className="flex items-center gap-1.5 text-muted">{a.label} <Address value={a.value} /></span>
            ))}
          </div>
        </div>
        <p className="max-w-md leading-relaxed">
          In-house adversarial review to convergence (engine, orderbook, SDK). External audit pending,
          do not treat as production-audited. Devnet only.
        </p>
      </div>
    </footer>
  );
}
