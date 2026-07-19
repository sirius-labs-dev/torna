#!/bin/bash
# TornaFan go-live: switch the deployed site to the World Cup final, ready for the live keeper.
# Run at kickoff (~19:00 UTC). Then start the keeper (fan-live.ts) and record tornafan.vercel.app/fan.
set -euo pipefail

SCR="/private/tmp/claude-502/-Users-nida/5457ee75-0096-4cf0-bb93-e85485583ab3/scratchpad"
DEMO="$SCR/torna/demo"
cd "$DEMO"

# --- final fixture config (double-check the matchup at kickoff; these are display + binding values) ---
export WALLET_KEYPAIR="$SCR/.wallet.json"
export ORDERBOOK_PROGRAM="DHYpWACQxwuTqRHPFi6VMLWXY5xfWRaBUDfZK1Weob78"
export TORNA_PROGRAM="C2vPNBochYrcF4yCHDrtn9SPXUobsjrfPnZ2RPHUcAN5"
export RPC="$(cat "$SCR/.rpc")"
export GAME_ID="${GAME_ID:-3}"
export LB_TREE="${LB_TREE:-9}"
export FIXTURE_ID="18257739"          # World Cup final
export STAT_KEY="${STAT_KEY:-1}"      # 1 = home goals (Spain). If no live proofs, try another key.
export STAT_PERIOD="100"
export PREV_VALUE="0"
export STAT_LABEL="${STAT_LABEL:-Spain goals}"
export HOME_TEAM="${HOME_TEAM:-Spain}"
export AWAY_TEAM="${AWAY_TEAM:-Argentina}"

echo "==> 1/3  bring up the final game (game $GAME_ID, tree $LB_TREE, fixture $FIXTURE_ID)"
npx tsx scripts/bringup-fan.ts

echo "==> 2/3  build"
npm run build -- --webpack >/tmp/go-live-build.log 2>&1 && echo "   build ok" || { echo "   BUILD FAILED — see /tmp/go-live-build.log"; exit 1; }

echo "==> 3/3  deploy + alias"
OUT=$(npx vercel --prod --yes 2>/dev/null | grep -oE "https://demo-[a-z0-9]+-hello-3615s-projects.vercel.app" | head -1)
npx vercel alias set "$OUT" tornafan.vercel.app  >/dev/null 2>&1
npx vercel alias set "$OUT" tornaline.vercel.app >/dev/null 2>&1
echo "   live: $OUT  ->  tornafan.vercel.app"

echo ""
echo "SITE IS ON THE FINAL. Now start the keeper (leave it running while you record):"
echo ""
echo "  JWT=\$(grep TXLINE_GUEST_JWT $SCR/.txtokens | cut -d= -f2-); API=\$(grep TXLINE_API_TOKEN $SCR/.txtokens | cut -d= -f2-)"
echo "  cd $DEMO"
echo "  WALLET_KEYPAIR=$SCR/.wallet.json SOLANA_RPC_URL=\"$RPC\" TXLINE_GUEST_JWT=\"\$JWT\" TXLINE_API_TOKEN=\"\$API\" POLL_MS=6000 npx tsx scripts/fan-live.ts"
echo ""
echo "If no live proofs appear after a few updates, fall back to the proven replay:"
echo "  ... SEQ=<latest proven seq> ROUNDS=8 DELAY_MS=4000 npx tsx scripts/fan-replay.ts"
