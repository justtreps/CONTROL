// Returns the count + minimum recharge amount needed to retry
// just the placements that bounced for balance reasons in the
// last 24h. Surfaced on the dashboard balance card.
//
// Middleware enforces session auth on /api/balance/*.

import { NextResponse } from "next/server";
import { getBalanceRetryBudget } from "@/lib/balance/retry-budget";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET() {
  const budget = await getBalanceRetryBudget();
  return NextResponse.json(budget, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
