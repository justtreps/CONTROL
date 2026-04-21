// Read-only paginated listing of PoolSeedHealthLog entries for the
// "HISTORIQUE VÉRIFICATIONS SEEDS" UI. Behind session auth (middleware
// catches it), no CRON_SECRET needed.
//
// GET ?limit=20&platform=instagram|tiktok|all
//   → { rows: PoolSeedHealthLog[], total: number }

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20)
  );
  const platform = url.searchParams.get("platform") ?? "all";

  const where = platform === "all" ? {} : { platform };
  const [rows, total] = await Promise.all([
    prisma.poolSeedHealthLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.poolSeedHealthLog.count({ where }),
  ]);

  return NextResponse.json({ rows, total });
}
