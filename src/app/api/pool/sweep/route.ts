import { NextResponse } from "next/server";
import { sweepInstagramPool } from "@/lib/pool/sweep";

// Sweep all Instagram available accounts against the IG mobile oracle
// (FIX 3). Idempotent: picks the oldest lastCheckedAt first so repeat
// runs resume automatically. limit defaults to 500, budgetMs 55s.
export const maxDuration = 60;

export async function POST(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(
    1000,
    Number(url.searchParams.get("limit") ?? 500) || 500
  );
  const budgetMs = Math.min(
    58_000,
    Number(url.searchParams.get("budgetMs") ?? 55_000) || 55_000
  );

  try {
    const stats = await sweepInstagramPool({ limit, budgetMs });
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
