"use client";

// Browser hook: subscribe to the server SSE relay (never to TxLINE directly). Reconnects are
// handled by EventSource; we just parse each event's JSON. Use for the live odds ticker (feeds
// the maker's target price) and the live score strip (goal/card flashes + the settlement CTA).
import { useEffect, useRef, useState } from "react";

export function useTxlineStream<T = unknown>(type: "odds" | "scores", fixtureId: number | null) {
  const [last, setLast] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!fixtureId) return;
    const es = new EventSource(`/api/txline/stream?type=${type}&fixtureId=${fixtureId}`);
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false); // EventSource auto-retries with Last-Event-ID
    es.onmessage = (e) => {
      try { setLast(JSON.parse(e.data) as T); } catch { /* heartbeat / non-JSON */ }
    };
    return () => { es.close(); esRef.current = null; };
  }, [type, fixtureId]);

  return { last, connected };
}
