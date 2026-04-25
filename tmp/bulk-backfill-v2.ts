// Bulk-mode backfill — replaces lib/catalogue/lifecycle.ts:
// backfillLifecycle which queries per-service and was too slow on
// 3500+ rows. Same target outcome:
//
//   • MONITORED bogus (no delivery on any TestOrder) → demote
//   • DEAD premature (< 7 d AND no delivery) → revive to TESTING
//   • TESTING with delivery → promote to QUALIFIED (or MONITORED
//     if ≥ 2 TestOrders)
//   • TESTING with oldest order ≥ 7 d AND no delivery → DEAD
//
// Strategy: pull every TestOrder + every Measurement in two
// queries, build per-service aggregates in memory, then issue
// bulk updateMany per target lifecycle status.

import { prisma } from "../src/lib/prisma";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

type Agg = {
  orderCount: number;
  oldestPlacedAt: Date | null;
  everDelivered: boolean;
};

async function main() {
  console.log("Loading orders + measurements…");
  const [orders, measurements, candidates] = await Promise.all([
    prisma.testOrder.findMany({
      select: {
        id: true,
        serviceId: true,
        baselineCount: true,
        placedAt: true,
      },
    }),
    prisma.measurement.findMany({
      select: { testOrderId: true, actualCount: true },
    }),
    prisma.productServiceCandidate.findMany({
      select: { id: true, serviceId: true, lifecycleStatus: true },
    }),
  ]);
  console.log(
    `  ${orders.length} TestOrders, ${measurements.length} Measurements, ${candidates.length} Candidates`
  );

  // Index measurements by testOrderId.
  const measByOrder = new Map<number, number[]>();
  for (const m of measurements) {
    const arr = measByOrder.get(m.testOrderId) ?? [];
    arr.push(m.actualCount);
    measByOrder.set(m.testOrderId, arr);
  }

  // Aggregate per service.
  const agg = new Map<number, Agg>();
  for (const o of orders) {
    let a = agg.get(o.serviceId);
    if (!a) {
      a = { orderCount: 0, oldestPlacedAt: null, everDelivered: false };
      agg.set(o.serviceId, a);
    }
    a.orderCount++;
    if (!a.oldestPlacedAt || o.placedAt < a.oldestPlacedAt) {
      a.oldestPlacedAt = o.placedAt;
    }
    const counts = measByOrder.get(o.id) ?? [];
    const peak = Math.max(o.baselineCount, ...counts);
    if (peak > o.baselineCount) a.everDelivered = true;
  }

  // Best-status per service.
  const RANK: Record<string, number> = {
    NEW: 0,
    TESTING: 1,
    QUALIFIED: 2,
    MONITORED: 3,
    DEAD: 4,
  };
  const best = new Map<number, string>();
  for (const c of candidates) {
    const cur = best.get(c.serviceId);
    if (!cur || RANK[c.lifecycleStatus] > RANK[cur]) {
      best.set(c.serviceId, c.lifecycleStatus);
    }
  }

  // Decide target per service.
  type Target = "NEW" | "TESTING" | "QUALIFIED" | "MONITORED" | "DEAD" | "no_change";
  const targets = new Map<number, Target>();
  for (const [serviceId, status] of Array.from(best.entries())) {
    const a = agg.get(serviceId) ?? {
      orderCount: 0,
      oldestPlacedAt: null,
      everDelivered: false,
    };
    const ageMs = a.oldestPlacedAt
      ? Date.now() - a.oldestPlacedAt.getTime()
      : 0;

    let target: Target = "no_change";
    if (status === "MONITORED") {
      if (!a.everDelivered) {
        target = a.orderCount > 0 ? "TESTING" : "NEW";
      }
    } else if (status === "DEAD") {
      if (!a.everDelivered && (a.orderCount === 0 || ageMs < SEVEN_DAYS_MS)) {
        target = a.orderCount > 0 ? "TESTING" : "NEW";
      }
    } else if (status === "TESTING" || status === "NEW") {
      if (a.everDelivered) {
        target = a.orderCount >= 2 ? "MONITORED" : "QUALIFIED";
      } else if (a.orderCount > 0 && ageMs >= SEVEN_DAYS_MS) {
        target = "DEAD";
      }
    } else if (status === "QUALIFIED") {
      if (a.orderCount >= 2) target = "MONITORED";
    }
    targets.set(serviceId, target);
  }

  // Bucket service IDs by target action.
  const promoteToQualified: number[] = [];
  const promoteToMonitored: number[] = [];
  const demoteToTesting: number[] = [];
  const demoteToNew: number[] = [];
  const reviveTesting: number[] = [];
  const reviveNew: number[] = [];
  const killT7d: number[] = [];

  for (const [serviceId, target] of Array.from(targets.entries())) {
    if (target === "no_change") continue;
    const cur = best.get(serviceId) ?? "NEW";
    if (cur === "MONITORED" && target === "TESTING") demoteToTesting.push(serviceId);
    else if (cur === "MONITORED" && target === "NEW") demoteToNew.push(serviceId);
    else if (cur === "DEAD" && target === "TESTING") reviveTesting.push(serviceId);
    else if (cur === "DEAD" && target === "NEW") reviveNew.push(serviceId);
    else if ((cur === "TESTING" || cur === "NEW") && target === "QUALIFIED") {
      promoteToQualified.push(serviceId);
    } else if ((cur === "TESTING" || cur === "NEW" || cur === "QUALIFIED") && target === "MONITORED") {
      promoteToMonitored.push(serviceId);
    } else if ((cur === "TESTING" || cur === "NEW") && target === "DEAD") {
      killT7d.push(serviceId);
    }
  }

  console.log(`\nActions:`);
  console.log(`  promoteToQualified : ${promoteToQualified.length}`);
  console.log(`  promoteToMonitored : ${promoteToMonitored.length}`);
  console.log(`  demoteToTesting    : ${demoteToTesting.length}`);
  console.log(`  demoteToNew        : ${demoteToNew.length}`);
  console.log(`  reviveTesting      : ${reviveTesting.length}`);
  console.log(`  reviveNew          : ${reviveNew.length}`);
  console.log(`  killT7d            : ${killT7d.length}`);

  // Bulk apply.
  if (promoteToQualified.length > 0) {
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: promoteToQualified } },
      data: { lifecycleStatus: "QUALIFIED" },
    });
  }
  if (promoteToMonitored.length > 0) {
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: promoteToMonitored } },
      data: { lifecycleStatus: "MONITORED" },
    });
  }
  if (demoteToTesting.length > 0) {
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: demoteToTesting } },
      data: { lifecycleStatus: "TESTING" },
    });
  }
  if (demoteToNew.length > 0) {
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: demoteToNew } },
      data: { lifecycleStatus: "NEW" },
    });
  }
  if (reviveTesting.length > 0) {
    await prisma.service.updateMany({
      where: { id: { in: reviveTesting } },
      data: { active: true },
    });
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: reviveTesting } },
      data: { lifecycleStatus: "TESTING", isEligible: true },
    });
    // Resolve the kill alerts for revived services.
    await prisma.alert.updateMany({
      where: {
        code: { startsWith: "service_killed_no_delivery:" },
        status: { in: ["active", "acknowledged"] },
        relatedEntityId: { in: reviveTesting },
        relatedEntityType: "service",
      },
      data: { status: "resolved", resolvedAt: new Date() },
    });
  }
  if (reviveNew.length > 0) {
    await prisma.service.updateMany({
      where: { id: { in: reviveNew } },
      data: { active: true },
    });
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: reviveNew } },
      data: { lifecycleStatus: "NEW", isEligible: true },
    });
  }
  if (killT7d.length > 0) {
    await prisma.service.updateMany({
      where: { id: { in: killT7d } },
      data: { active: false },
    });
    await prisma.productServiceCandidate.updateMany({
      where: { serviceId: { in: killT7d } },
      data: { lifecycleStatus: "DEAD", isEligible: false },
    });
  }

  // Final counts.
  const after = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const finalBest = new Map<number, string>();
  for (const r of after) {
    const cur = finalBest.get(r.serviceId);
    if (!cur || RANK[r.lifecycleStatus] > RANK[cur]) {
      finalBest.set(r.serviceId, r.lifecycleStatus);
    }
  }
  const counts = { NEW: 0, TESTING: 0, QUALIFIED: 0, MONITORED: 0, DEAD: 0 };
  for (const v of Array.from(finalBest.values())) counts[v as keyof typeof counts]++;
  console.log(`\n=== AFTER ===`);
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
