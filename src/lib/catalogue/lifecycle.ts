// Service lifecycle state machine.
//
// Each ProductServiceCandidate carries a lifecycleStatus field that
// transitions through the following states during its life:
//
//   NEW       → first time ever seen, never tested
//   TESTING   → has a running TestOrder, waiting on completion
//   QUALIFIED → most recent completed test delivered > 0 AND the
//               scoring engine gave it currentScore >= 40
//   MONITORED → qualified + in the daily retest loop (automatic
//               transition — QUALIFIED is just the threshold
//               moment, MONITORED is the steady state)
//   DEAD      → 2 consecutive 0-delivery terminal tests → kill
//
// The state machine is edge-triggered:
//   - onPlacement(serviceId)         NEW → TESTING
//   - onTestCompleted(testOrder)     TESTING/MONITORED → one of
//                                    QUALIFIED / MONITORED / DEAD
//   - forceKill(serviceId)           any → DEAD (operator override)
//   - revive(serviceId)              DEAD → MONITORED
//
// Kill is service-wide — all candidacies for the service flip to
// DEAD and service.active=false. The per-product column supports
// future product-specific kill logic without a schema change.

import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";

export type LifecycleStatus =
  | "NEW"
  | "TESTING"
  | "QUALIFIED"
  | "MONITORED"
  | "DEAD";

// Score floor for a service to be considered QUALIFIED. Below this
// the service stays in TESTING (keeps getting retested at the next
// campaign tick, eventually drifts to DEAD if delivery is 0).
export const QUALIFY_SCORE = 40;

// NEW → TESTING. Called from lib/testbot.ts right after TestOrder
// creation. No-op if already past TESTING.
export async function markTesting(serviceId: number): Promise<void> {
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId, lifecycleStatus: "NEW" },
    data: { lifecycleStatus: "TESTING" },
  });
}

// Called from the poller when a TestOrder transitions to
// completed/aborted. Decides the next lifecycle state based on
// the last 2 test outcomes + the service's current score.
export async function onTestCompleted(params: {
  serviceId: number;
  // The row we just finalised — passed in so the caller doesn't
  // double-fetch.
  testOrderId: number;
  deliveredQty: number;
}): Promise<{
  transition: "QUALIFIED" | "MONITORED" | "DEAD" | "stayed_testing" | "no_change";
  reason?: string;
}> {
  const toggles = await getSystemToggles();

  // 1. Compute the auto-kill signal: last 2 terminal TestOrders
  //    for this service, both delivered == 0.
  let killSignal = false;
  if (toggles.autoKillDeadServicesEnabled) {
    const lastTwo = await prisma.testOrder.findMany({
      where: {
        serviceId: params.serviceId,
        status: { in: ["completed", "aborted_target_died", "aborted_other"] },
      },
      include: { measurements: true },
      orderBy: { completedAt: "desc" },
      take: 2,
    });
    if (lastTwo.length === 2) {
      const delivered = lastTwo.map((o) => {
        const peak = Math.max(
          o.baselineCount,
          ...o.measurements.map((m) => m.actualCount)
        );
        return peak - o.baselineCount;
      });
      if (delivered.every((d) => d <= 0)) killSignal = true;
    }
  }

  if (killSignal) {
    await killService(params.serviceId, "auto_no_delivery_2x");
    return { transition: "DEAD", reason: "2 consecutive 0-delivery tests" };
  }

  // 2. If delivery > 0 on this test → candidates are QUALIFIED (if
  //    not already past that) or MONITORED (if scoring already
  //    picked them up). Use score-floor to decide.
  if (params.deliveredQty > 0) {
    const topScore = await prisma.productServiceCandidate.findFirst({
      where: { serviceId: params.serviceId },
      orderBy: { currentScore: "desc" },
      select: { currentScore: true },
    });
    const score = topScore?.currentScore ?? 0;
    const nextStatus: LifecycleStatus =
      score >= QUALIFY_SCORE ? "MONITORED" : "QUALIFIED";
    await prisma.productServiceCandidate.updateMany({
      where: {
        serviceId: params.serviceId,
        lifecycleStatus: { in: ["NEW", "TESTING", "QUALIFIED"] },
      },
      data: { lifecycleStatus: nextStatus },
    });
    return { transition: nextStatus };
  }

  // 3. Delivered zero but auto-kill didn't fire (needs 2 in a row
  //    or toggle off). Leave the candidate in whatever state it
  //    was — a single zero delivery isn't terminal on its own.
  return { transition: "stayed_testing" };
}

// Service-wide kill. Flips active=false on Service (so the router
// skips it) + lifecycleStatus=DEAD on every candidate, then emits
// a best-effort alert for visibility.
export async function killService(
  serviceId: number,
  reason: string
): Promise<void> {
  await prisma.service.update({
    where: { id: serviceId },
    data: { active: false },
  });
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId },
    data: { lifecycleStatus: "DEAD", isEligible: false },
  });
  // The alert detector detectServiceKilledNoDelivery surfaces this
  // on the next /api/cron/alerts-detector tick — the row is
  // created here so even if the detector is late we have audit.
  // Alert.code isn't unique (the column lives in schema as plain
  // String) so we can't upsert; findFirst + update-or-create does
  // the same job with a tiny race window that's fine for alerts.
  try {
    const code = `service_killed_no_delivery:${serviceId}`;
    const existing = await prisma.alert.findFirst({
      where: { code, status: { in: ["active", "acknowledged"] } },
    });
    if (existing) {
      await prisma.alert.update({
        where: { id: existing.id },
        data: {
          lastTriggeredAt: new Date(),
          triggerCount: { increment: 1 },
          status: "active",
        },
      });
    } else {
      await prisma.alert.create({
        data: {
          code,
          category: "catalogue",
          severity: "warning",
          title: `Service #${serviceId} désactivé auto (${reason})`,
          description: `2 tests consécutifs sans livraison mesurée — service retiré du catalogue routable.`,
          explanation: `Le lifecycle coordinator a observé 2 TestOrder terminaux consécutifs avec deliveredQty=0 sur ce service. Auto-kill suppose que le fournisseur BulkMedya ne livre plus sur cet ID — active=false pour écarter le service du routage, lifecycleStatus=DEAD sur toutes ses candidacies. Manual revive possible via /config/catalogue si l'opérateur veut retester.`,
          impact: "Le service n'est plus routable et ne sera plus retesté automatiquement. Si d'autres services du même produit sont QUALIFIED le routage s'adapte sans intervention.",
          suggestedAction: "Aller sur /config/catalogue, ouvrir le drawer du produit correspondant, cliquer REVIVE si besoin de retester.",
          actionType: "link",
          actionPayload: { href: "/config/catalogue" },
          relatedEntityType: "service",
          relatedEntityId: serviceId,
          status: "active",
          firstTriggeredAt: new Date(),
          lastTriggeredAt: new Date(),
          triggerCount: 1,
        },
      });
    }
  } catch {
    // Alert write is best-effort — the kill itself already landed.
  }
}

// Operator-triggered resurrection. DEAD services can re-enter the
// retest loop (useful when BulkMedya fixes a provider and the
// operator wants to give the service another chance).
export async function reviveService(serviceId: number): Promise<void> {
  await prisma.service.update({
    where: { id: serviceId },
    data: { active: true },
  });
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId, lifecycleStatus: "DEAD" },
    data: { lifecycleStatus: "MONITORED", isEligible: true },
  });
  // Auto-resolve the kill alert so the dashboard reflects the
  // change without waiting for the next detector tick.
  await prisma.alert
    .updateMany({
      where: {
        code: `service_killed_no_delivery:${serviceId}`,
        status: { in: ["active", "acknowledged"] },
      },
      data: { status: "resolved", resolvedAt: new Date() },
    })
    .catch(() => null);
}

// Counts for the dashboard CYCLE DE VIE CATALOGUE card. Grouped
// by lifecycle status, de-duped to distinct services so a service
// with 3 candidacies doesn't count 3×.
export async function lifecycleCounts(): Promise<Record<LifecycleStatus, number>> {
  const out: Record<LifecycleStatus, number> = {
    NEW: 0,
    TESTING: 0,
    QUALIFIED: 0,
    MONITORED: 0,
    DEAD: 0,
  };
  // Distinct by serviceId — take the "most advanced" status per
  // service (DEAD > MONITORED > QUALIFIED > TESTING > NEW) so the
  // dashboard totals align with the intuition "how many services
  // are in each state".
  const rank: Record<LifecycleStatus, number> = {
    NEW: 0,
    TESTING: 1,
    QUALIFIED: 2,
    MONITORED: 3,
    DEAD: 4,
  };
  const rows = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const best = new Map<number, LifecycleStatus>();
  for (const r of rows) {
    const cur = best.get(r.serviceId);
    const next = r.lifecycleStatus as LifecycleStatus;
    if (!cur || rank[next] > rank[cur]) best.set(r.serviceId, next);
  }
  for (const v of Array.from(best.values())) out[v]++;
  return out;
}

// Backfill helper — run once after the schema ships to migrate
// existing data into the new lifecycle states. Idempotent.
export async function backfillLifecycle(): Promise<{
  inspected: number;
  seededNew: number;
  seededTesting: number;
  seededQualified: number;
  seededMonitored: number;
  seededDead: number;
}> {
  const result = {
    inspected: 0,
    seededNew: 0,
    seededTesting: 0,
    seededQualified: 0,
    seededMonitored: 0,
    seededDead: 0,
  };

  // Pull every candidate + its service's latest scoring + order
  // state so we can decide the bucket in memory.
  const cands = await prisma.productServiceCandidate.findMany({
    select: {
      id: true,
      serviceId: true,
      currentScore: true,
      isEligible: true,
      lifecycleStatus: true,
      service: { select: { active: true, lastTestedAt: true } },
    },
  });
  result.inspected = cands.length;

  for (const c of cands) {
    let target: LifecycleStatus;
    if (!c.service.active) {
      target = "DEAD";
    } else if (!c.service.lastTestedAt) {
      target = "NEW";
    } else if ((c.currentScore ?? 0) >= QUALIFY_SCORE) {
      target = "MONITORED";
    } else if (c.isEligible) {
      // Eligible + tested but no good score → still TESTING.
      // The next retest will push it forward or to DEAD.
      target = "TESTING";
    } else {
      target = "NEW";
    }
    if ((c.lifecycleStatus as string) !== target) {
      await prisma.productServiceCandidate.update({
        where: { id: c.id },
        data: { lifecycleStatus: target },
      });
    }
    // Backfill never produces QUALIFIED — it's a transient state
    // between "first test passed" and "enrolled in retest loop".
    // Services already in the DB are either still-testing or
    // past-qualification, so we route them straight to MONITORED
    // when they have a usable score.
    if (target === "NEW") result.seededNew++;
    else if (target === "TESTING") result.seededTesting++;
    else if (target === "MONITORED") result.seededMonitored++;
    else if (target === "DEAD") result.seededDead++;
  }

  return result;
}
