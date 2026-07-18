// GET /api/txline/stream?type=odds|scores&fixtureId=
// Server-side relay of a TxLINE SSE feed to the browser. The browser opens an EventSource against
// THIS route (no tokens in the client); we hold one upstream connection per stream and re-emit
// each event. Closing the browser tab aborts the upstream via req.signal.
import { NextRequest } from "next/server";
import { txlineStream, type TxStream } from "@/lib/txline/streams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const type = (sp.get("type") as TxStream) || "odds";
  const fixtureId = Number(sp.get("fixtureId"));
  const lastEventId = req.headers.get("last-event-id") ?? undefined;

  if (!fixtureId || (type !== "odds" && type !== "scores")) {
    return new Response("bad params: type=odds|scores & fixtureId required", { status: 400 });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const send = (id: string | undefined, data: string) => {
        if (id) controller.enqueue(encoder.encode(`id: ${id}\n`));
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);
      try {
        for await (const evt of txlineStream(type, fixtureId, req.signal, lastEventId)) {
          send(evt.id, evt.data);
        }
      } catch (e) {
        try { send(undefined, JSON.stringify({ error: e instanceof Error ? e.message : String(e) })); } catch { /* closed */ }
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
