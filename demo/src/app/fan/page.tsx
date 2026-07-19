import { FanGame } from "@/components/FanGame";

export const metadata = {
  title: "TornaFan — call the match, climb the board",
  description: "Tap Higher or Lower on what happens next on the pitch, build a streak, and climb a provably-fair live leaderboard. Powered by TxLINE, built on Torna.",
};

export default function FanPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">The live game for football fans</p>
        <h1 className="display mt-2 text-4xl font-semibold tracking-tight">TornaFan</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
          Call what happens next on the pitch. Build a streak. Climb a leaderboard the whole stadium is
          on — scored live by verifiable TxLINE data, so no one can fake the result.
        </p>
      </div>
      <FanGame />
    </div>
  );
}
