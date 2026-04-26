import { prisma } from "../src/lib/prisma";

async function main() {
  // De-dup serviceId → best lifecycle
  const RANK: Record<string, number> = { NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4, PLACEMENT_FAILED:5, REMOVED_FROM_BULKMEDYA:6, PERMANENTLY_FAILED:7, DEPRECATED_PRODUCT:8 };

  const stamped = await prisma.service.findMany({
    where: {
      lastPlacementError: { contains: "backfilled" },
    },
    select: {
      id: true,
      productCandidacies: {
        select: { lifecycleStatus: true },
      },
    },
  });
  console.log(`Total services with backfilled stamp: ${stamped.length}`);

  const buckets: Record<string, number> = {};
  const placedAndShouldClear: number[] = [];
  const stillFailed: number[] = [];

  for (const s of stamped) {
    let best = "NEW";
    for (const c of s.productCandidacies) {
      if (RANK[c.lifecycleStatus] > RANK[best]) best = c.lifecycleStatus;
    }
    buckets[best] = (buckets[best] ?? 0) + 1;
    // Services in TESTING/QUALIFIED/MONITORED = placement succeeded → clear stamp
    if (["TESTING", "QUALIFIED", "MONITORED"].includes(best)) {
      placedAndShouldClear.push(s.id);
    } else if (best === "PLACEMENT_FAILED") {
      stillFailed.push(s.id);
    }
  }
  console.log(`\nLifecycle distribution of backfilled-stamped services:`);
  for (const [k, v] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`\n=> ${placedAndShouldClear.length} services PLACED successfully — stamps should be cleared`);
  console.log(`=> ${stillFailed.length} services still PLACEMENT_FAILED — keep their stamp`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
