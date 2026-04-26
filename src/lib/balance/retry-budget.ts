// Helper for the BulkMedya balance recharge UX.
//
// Two questions to answer:
//   1. How many service placements bounced off insufficient
//      balance in the last 24h?
//   2. What's the minimum recharge amount needed to retry just
//      those (not 30 days of forecast — the immediate backlog)?
//
// Source of truth: Service.lastPlacementError + lastPlacementErrorAt
// stamped by placeBruteOne / attemptPlaceOrder when BulkMedya
// returns an error containing a balance signal.
//
// Match pattern is intentionally loose so it catches BulkMedya's
// various wordings: "neutral_balance", "Not enough fund",
// "insufficient balance", "low balance", etc.

import { prisma } from "@/lib/prisma";
import { testCostUsd, testQuantityFor } from "@/lib/scoring/test-quantity";

const BALANCE_REGEX = /balance|insufficient|neutral|fund|not enough|low ?bal/i;

export type BalanceRetryBudget = {
  failedCount: number;
  minBudgetUsd: number;
  // Top 5 services by cost — surfaces the rows that drove the
  // total so the operator can sanity-check the number.
  sample: Array<{
    id: number;
    name: string;
    platform: string;
    cost: number;
    error: string;
    erroredAt: string;
  }>;
};

export async function getBalanceRetryBudget(): Promise<BalanceRetryBudget> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const services = await prisma.service.findMany({
    where: {
      lastPlacementErrorAt: { gte: since },
      lastPlacementError: { not: null },
    },
    select: {
      id: true,
      name: true,
      platform: true,
      ratePerK: true,
      minQuantity: true,
      maxQuantity: true,
      lastPlacementError: true,
      lastPlacementErrorAt: true,
    },
  });

  const matched = services.filter(
    (s) => s.lastPlacementError && BALANCE_REGEX.test(s.lastPlacementError)
  );

  let total = 0;
  const enriched = matched
    .map((s) => {
      const cost = testCostUsd(s);
      if (cost === null) return null;
      total += cost;
      return {
        id: s.id,
        name: s.name,
        platform: s.platform,
        cost,
        error: s.lastPlacementError ?? "",
        erroredAt: s.lastPlacementErrorAt?.toISOString() ?? "",
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return {
    failedCount: enriched.length,
    minBudgetUsd: Math.round(total * 100) / 100,
    sample: enriched.sort((a, b) => b.cost - a.cost).slice(0, 5),
  };
}

// Returns the list of service IDs eligible for retry — used by
// /api/balance/retry-failed to spawn the brute campaign.
export async function listBalanceFailedServiceIds(): Promise<number[]> {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const rows = await prisma.service.findMany({
    where: {
      lastPlacementErrorAt: { gte: since },
      lastPlacementError: { not: null },
      active: true,
    },
    select: {
      id: true,
      lastPlacementError: true,
      maxQuantity: true,
      minQuantity: true,
    },
  });
  return rows
    .filter(
      (s) =>
        s.lastPlacementError &&
        BALANCE_REGEX.test(s.lastPlacementError) &&
        testQuantityFor(s) !== null
    )
    .map((s) => s.id);
}
