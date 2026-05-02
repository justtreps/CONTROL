import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/api/order",
  "/api/cron",
  "/api/healthz",
  // Public-routed but cron-auth'd (Bearer CRON_SECRET). Lets the
  // internal fire-and-forget refill trigger from suggestions-dynamic
  // hit this path, and allows manual priming via curl.
  "/api/pool/seeds/refill-pool",
  // One-shot migration endpoints — also cron-auth'd, kept open so
  // operators can curl them after schema bumps.
  "/api/pool/reclassify-services",
  "/api/pool/backfill-country",
  "/api/pool/backfill-last-tested",
  "/api/pool/reconcile-engagement",
  "/api/pool/queue-scrape",
  "/api/pool/recover-engagement-impact",
  "/api/pool/force-place",
  "/api/pool/migrate-reliability-factor",
  "/api/catalogue/seed",
  "/api/catalogue/rematch",
  "/api/workflows/seed",
  "/api/scoring/cleanup-sim",
  "/api/scoring/recompute-reliability",
  "/api/scoring/recompute-ranks",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts|.*\\.(?:mov|mp4|webm|png|jpg|jpeg|webp|svg|gif|ico|woff|woff2)$).*)",
  ],
};
