import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Two products, one deployment: tornafan.vercel.app serves the fan game at its root, while
// tornaline.vercel.app keeps the prediction market. Rewrite (not redirect) so the URL stays clean.
export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  if (host.startsWith("tornafan") && req.nextUrl.pathname === "/") {
    const url = req.nextUrl.clone();
    url.pathname = "/fan";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: "/" };
