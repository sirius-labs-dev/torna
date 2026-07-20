import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Two separate products share this codebase but are distinct entries in different hackathon tracks:
// TornaLine (the market) lives at tornaline.vercel.app, TornaFan (the game) at tornafan.vercel.app.
// Each host serves only its own product — the other product's route is redirected to its own domain,
// so neither site exposes the other. (Local dev and preview URLs see both routes, unchanged.)
export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const path = req.nextUrl.pathname;
  const isFan = host.startsWith("tornafan");
  const isLine = host.startsWith("tornaline");

  // tornafan.vercel.app: serve the game at the root.
  if (isFan && path === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/fan";
    return NextResponse.rewrite(url);
  }
  // Keep each host to its own product.
  if (isFan && path.startsWith("/trade")) {
    return NextResponse.redirect(new URL(path, "https://tornaline.vercel.app"));
  }
  if (isLine && path.startsWith("/fan")) {
    return NextResponse.redirect(new URL("/", "https://tornafan.vercel.app"));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/fan", "/fan/:path*", "/trade", "/trade/:path*"] };
