import { NextResponse } from "next/server";
import { sweepPool, type SweepStats } from "@/lib/pool/sweep";

// Sweep all 'available' accounts for a platform against the oracle.
// ?platform=instagram | tiktok | both (default: instagram)
// ?limit=500 ?budgetMs=55000 — tuned to stay under the 60s Vercel cap.
export const maxDuration = 60;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const platformParam = url.searchParams.get("platform") ?? "instagram";
  const limit = Math.min(
    1000,
    Number(url.searchParams.get("limit") ?? 500) || 500
  );
  const budgetMs = Math.min(
    58_000,
    Number(url.searchParams.get("budgetMs") ?? 55_000) || 55_000
  );

  if (
    platformParam !== "instagram" &&
    platformParam !== "tiktok" &&
    platformParam !== "both"
  ) {
    return NextResponse.json(
      { error: "platform must be instagram | tiktok | both" },
      { status: 400 }
    );
  }

  try {
    if (platformParam === "both") {
      const half = Math.floor(budgetMs / 2);
      const ig = await sweepPool({
        platform: "instagram",
        limit,
        budgetMs: half,
      });
      const ttBudget = Math.max(5_000, budgetMs - ig.durationMs);
      const tt = await sweepPool({
        platform: "tiktok",
        limit,
        budgetMs: ttBudget,
      });
      return NextResponse.json({ ok: true, instagram: ig, tiktok: tt });
    }
    const stats: SweepStats = await sweepPool({
      platform: platformParam,
      limit,
      budgetMs,
    });
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
