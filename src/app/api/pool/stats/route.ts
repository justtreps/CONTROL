import { NextResponse } from "next/server";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeHistory = url.searchParams.get("history") === "1";
  const poolParam = url.searchParams.get("pool");
  const pool: "follower" | "engagement" =
    poolParam === "engagement" ? "engagement" : "follower";

  const stats = await getPoolStats();
  const history = includeHistory ? await getPoolHistory30d(pool) : null;

  return NextResponse.json({ stats, history });
}
