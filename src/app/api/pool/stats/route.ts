import { NextResponse } from "next/server";
import { getPoolStats, getPoolHistory30d } from "@/lib/pool/stats";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const includeHistory = url.searchParams.get("history") === "1";

  const stats = await getPoolStats();
  const history = includeHistory ? await getPoolHistory30d() : null;

  return NextResponse.json({ stats, history });
}
