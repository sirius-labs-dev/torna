// Server-side consumers for the TxLINE SSE feeds:
//   GET /api/odds/stream?fixtureId=   — live demargined odds  (drives the maker)
//   GET /api/scores/stream?fixtureId= — live goals/cards/state (drives UI + settlement trigger)
//
// Both are text/event-stream. We resume with Last-Event-ID so a reconnect never skips the goal
// that just moved the market. Tokens stay server-side; the browser subscribes to our own relay
// (app/api/txline/stream) instead of hitting TxLINE directly.

import { txlineConfig, apiUrl } from "./config";
import { refreshGuestJwt } from "./client";

export type TxStream = "odds" | "scores";

export interface SseEvent {
  id?: string;
  event?: string;
  data: string; // raw JSON string; caller parses
}

/**
 * Open an upstream TxLINE SSE stream and yield parsed events. Auto-resumes from the last seen id
 * on a dropped connection; refreshes the guest JWT once on a 401.
 */
export async function* txlineStream(
  stream: TxStream,
  fixtureId: number,
  signal: AbortSignal,
  lastEventId?: string,
): AsyncGenerator<SseEvent> {
  const cfg = txlineConfig();
  let jwt = cfg.guestJwt;
  let cursor = lastEventId;

  while (!signal.aborted) {
    const url = apiUrl(cfg.host, `/${stream}/stream?fixtureId=${fixtureId}`);
    const h: HeadersInit = {
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": cfg.apiToken,
      Accept: "text/event-stream",
    };
    if (cursor) (h as Record<string, string>)["Last-Event-ID"] = cursor;

    const res = await fetch(url, { headers: h, signal });
    if (res.status === 401) {
      jwt = await refreshGuestJwt(cfg);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`${stream}/stream -> ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break; // upstream closed -> reconnect from cursor
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const evt = parseFrame(frame);
          if (evt) {
            if (evt.id) cursor = evt.id;
            if (evt.data.trim() && evt.data.trim() !== "heartbeat") yield evt;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseFrame(frame: string): SseEvent | null {
  const out: SseEvent = { data: "" };
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const val = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") out.id = val;
    else if (field === "event") out.event = val;
    else if (field === "data") dataLines.push(val);
  }
  if (!dataLines.length && !out.id) return null;
  out.data = dataLines.join("\n");
  return out;
}
