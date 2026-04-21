// Refill the PoolSeedSuggestionPool cache for one platform.
//
// Called by:
//   • the 15-min cron at /api/cron/suggestions-refill (internal fetch)
//   • a human, to manually prime the cache (via curl + CRON_SECRET)
//
// Auth: Bearer CRON_SECRET (same pattern as other cron-adjacent POSTs).
//
// Query: ?platform=instagram|tiktok  (defaults to both when omitted)
//
// Response: { ok: true, results: [{ platform, before, after, added, source }] }

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import {
  refillSuggestionPool,
  type PlatformId,
} from "@/lib/pool/suggestion-pool";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const raw = url.searchParams.get("platform");
  const platforms: PlatformId[] =
    raw === "instagram" || raw === "tiktok" ? [raw] : ["instagram", "tiktok"];

  const results = [];
  for (const p of platforms) {
    try {
      results.push(await refillSuggestionPool(p));
    } catch (e) {
      results.push({
        platform: p,
        error: (e as Error).message,
      });
    }
  }
  return NextResponse.json({ ok: true, results });
}

// Alias GET so you can hit it from a browser with a query string during
// debugging; still auth'd.
export const GET = POST;
