// The retry has run. Balance was demonstrably OK during
// campaign #5 (693 placements went through). Any remaining
// service with a 'backfilled' synthetic marker has either:
//   • re-failed campaign #5 for a NON-balance reason
//     (max_below_floor, service_not_found, pool exhaustion,
//     runtime exception)
//   • or genuinely never been retried (campaign #5's queue cap)
//
// Either way, the 'backfilled' tag is misleading the operator
// — the BalanceRetryCard treats them as balance-bounced when
// they're not. Clear all backfilled stamps. Future failures
// will be re-stamped with their REAL reason on the next
// placement attempt.

import { prisma } from "../src/lib/prisma";
import { getBalanceRetryBudget } from "../src/lib/balance/retry-budget";

async function main() {
  const before = await getBalanceRetryBudget();
  console.log(`BEFORE: ${before.failedCount} services / $${before.minBudgetUsd.toFixed(2)}`);

  const r = await prisma.service.updateMany({
    where: { lastPlacementError: { contains: "backfilled" } },
    data: { lastPlacementError: null, lastPlacementErrorAt: null },
  });
  console.log(`Cleared ${r.count} backfilled stamps`);

  const after = await getBalanceRetryBudget();
  console.log(`AFTER : ${after.failedCount} services / $${after.minBudgetUsd.toFixed(2)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
