// Diagnostic for the lifecycle reset. Returns counts + sample
// service IDs per category so we can audit before cleanup runs.
//
// Per Amir's spec:
//   • MONITORED valid    = has ≥1 Measurement.actualCount > baselineCount
//   • MONITORED bogus    = no qualifying measurement → demote
//   • DEAD valid         = oldest TestOrder ≥ 7d old AND no delivery
//   • DEAD premature     = oldest TestOrder < 7d → revive to TESTING
//   • TESTING qualified  = has ≥1 qualifying measurement → promote QUALIFIED

import { prisma } from "../src/lib/prisma";

async function hasDelivered(serviceId: number): Promise<boolean> {
  const orders = await prisma.testOrder.findMany({
    where: { serviceId },
    include: { measurements: true },
  });
  for (const o of orders) {
    const peak = Math.max(
      o.baselineCount,
      ...o.measurements.map((m) => m.actualCount)
    );
    if (peak > o.baselineCount) return true;
  }
  return false;
}

async function oldestOrderAgeDays(serviceId: number): Promise<number | null> {
  const oldest = await prisma.testOrder.findFirst({
    where: { serviceId },
    orderBy: { placedAt: "asc" },
    select: { placedAt: true },
  });
  if (!oldest) return null;
  return Math.floor(
    (Date.now() - oldest.placedAt.getTime()) / (24 * 60 * 60_000)
  );
}

async function main() {
  // Distinct services per status (best-status semantics: take the
  // most-advanced lifecycleStatus across that service's candidacies).
  const rank: Record<string, number> = {
    NEW: 0,
    TESTING: 1,
    QUALIFIED: 2,
    MONITORED: 3,
    DEAD: 4,
  };
  const all = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const best = new Map<number, string>();
  for (const r of all) {
    const cur = best.get(r.serviceId);
    if (!cur || rank[r.lifecycleStatus] > rank[cur]) {
      best.set(r.serviceId, r.lifecycleStatus);
    }
  }

  const monitored: number[] = [];
  const dead: number[] = [];
  const testing: number[] = [];
  for (const [sid, status] of Array.from(best.entries())) {
    if (status === "MONITORED") monitored.push(sid);
    else if (status === "DEAD") dead.push(sid);
    else if (status === "TESTING") testing.push(sid);
  }

  // ─── MONITORED ─────────────────────────────────────────────
  let monitoredValid = 0;
  let monitoredBogus = 0;
  const monitoredBogusIds: number[] = [];
  for (const sid of monitored) {
    if (await hasDelivered(sid)) monitoredValid++;
    else {
      monitoredBogus++;
      monitoredBogusIds.push(sid);
    }
  }
  console.log(`\n=== MONITORED (${monitored.length} services) ===`);
  console.log(`  ✅ Valid (≥1 delivered measurement): ${monitoredValid}`);
  console.log(`  ❌ Bogus (no qualifying delivery):    ${monitoredBogus}`);
  if (monitoredBogusIds.length > 0) {
    console.log(`     bogus IDs: ${monitoredBogusIds.slice(0, 10).join(", ")}${monitoredBogusIds.length > 10 ? "…" : ""}`);
  }

  // ─── DEAD ──────────────────────────────────────────────────
  let deadValid = 0;
  let deadPremature = 0;
  const deadPrematureIds: number[] = [];
  for (const sid of dead) {
    const age = await oldestOrderAgeDays(sid);
    if (age === null) {
      // No TestOrder at all — can't say either way; keep as bogus
      // dead (probably from manual kill or backfill misclass).
      deadPremature++;
      deadPrematureIds.push(sid);
      continue;
    }
    if (age >= 7) deadValid++;
    else {
      deadPremature++;
      deadPrematureIds.push(sid);
    }
  }
  console.log(`\n=== DEAD (${dead.length} services) ===`);
  console.log(`  ✅ Valid (oldest order ≥ 7d):        ${deadValid}`);
  console.log(`  ❌ Premature (< 7d, kill rollback):  ${deadPremature}`);
  if (deadPrematureIds.length > 0) {
    console.log(`     premature IDs: ${deadPrematureIds.join(", ")}`);
  }

  // ─── TESTING ───────────────────────────────────────────────
  let testingQualified = 0;
  const testingQualifiedIds: number[] = [];
  let testingStillTesting = 0;
  for (const sid of testing) {
    if (await hasDelivered(sid)) {
      testingQualified++;
      testingQualifiedIds.push(sid);
    } else testingStillTesting++;
  }
  console.log(`\n=== TESTING (${testing.length} services) ===`);
  console.log(`  ⤴️  Should be QUALIFIED (has delivery): ${testingQualified}`);
  console.log(`  ⏳ Still TESTING (no delivery yet):    ${testingStillTesting}`);
  if (testingQualifiedIds.length > 0) {
    console.log(`     promote IDs (sample): ${testingQualifiedIds.slice(0, 10).join(", ")}${testingQualifiedIds.length > 10 ? "…" : ""}`);
  }

  console.log(`\n=== Cleanup actions queued ===`);
  console.log(`  MONITORED → demote: ${monitoredBogus}`);
  console.log(`  DEAD → revive (TESTING + service.active=true): ${deadPremature}`);
  console.log(`  TESTING → promote QUALIFIED: ${testingQualified}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
