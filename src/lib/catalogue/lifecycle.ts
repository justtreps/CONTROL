// Service lifecycle state machine.
//
// New rule (April 2026): qualify FAST, die SLOW.
//
//   NEW       → never tested
//   TESTING   → has a running TestOrder, no qualifying measurement yet
//   QUALIFIED → first time RapidAPI measured actualCount > baseline
//               on ANY of the service's TestOrders. Score doesn't
//               matter — what matters is "the provider actually
//               delivered something". Happens at poll-time, not
//               wait-for-T+7d.
//   MONITORED → QUALIFIED + has been retested at least once (i.e.
//               has ≥ 2 TestOrders). The daily-retest cron picks
//               MONITORED services so the score stays fresh.
//   DEAD      → status TESTING and oldest TestOrder ≥ 7 days old
//               with no delivery EVER, OR a QUALIFIED/MONITORED
//               service whose last 2 retests both delivered 0.
//               Initial-test services NEVER die before T+7d —
//               BulkMedya can be slow, the operator should give it
//               the full window.
//
// Three entry points:
//   • markTesting(serviceId)             NEW → TESTING (placement)
//   • onMeasurementWritten(...)          per-poll: triggers QUALIFIED /
//                                        MONITORED on first delivery
//                                        signal
//   • onTestCompleted(...)               at finalize: triggers DEAD
//                                        via T+7d sunset OR 2-zero
//                                        rule on retests
//
// Kill is service-wide — service.active=false + DEAD on every
// candidacy. revive() is the operator-facing inverse.

import { prisma } from "@/lib/prisma";
import { getSystemToggles } from "@/lib/system/toggles";

export type LifecycleStatus =
  | "NEW"
  | "TESTING"
  | "QUALIFIED"
  | "MONITORED"
  | "DEAD"
  | "PLACEMENT_FAILED"
  | "REMOVED_FROM_BULKMEDYA"
  | "PERMANENTLY_FAILED"
  | "DEPRECATED_PRODUCT";

const RANK: Record<LifecycleStatus, number> = {
  NEW: 0,
  TESTING: 1,
  QUALIFIED: 2,
  MONITORED: 3,
  DEAD: 4,
  PLACEMENT_FAILED: 5,
  REMOVED_FROM_BULKMEDYA: 6,
  PERMANENTLY_FAILED: 7,
  DEPRECATED_PRODUCT: 8,
};

// Returns the most-advanced lifecycle status across all of the
// service's candidacies.
async function bestStatus(
  serviceId: number
): Promise<LifecycleStatus | null> {
  const rows = await prisma.productServiceCandidate.findMany({
    where: { serviceId },
    select: { lifecycleStatus: true },
  });
  if (rows.length === 0) return null;
  let best: LifecycleStatus = "NEW";
  for (const r of rows) {
    const s = r.lifecycleStatus as LifecycleStatus;
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}

// NEW → TESTING. No-op if any candidacy has already moved past
// NEW. Called from lib/testbot.ts right after TestOrder.create.
export async function markTesting(serviceId: number): Promise<void> {
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId, lifecycleStatus: "NEW" },
    data: { lifecycleStatus: "TESTING" },
  });
}

// Called by the poller every time it writes a Measurement (poll
// or finalize). The earlier version only ran at finalize, which
// meant a service that delivered in 30 min sat in TESTING for
// 7 days. Now: as soon as deliveredQty > 0 → QUALIFIED.
//
// MONITORED transition fires when QUALIFIED service has ≥2
// TestOrders (proxy for "has been retested at least once").
export async function onMeasurementWritten(params: {
  serviceId: number;
  deliveredQty: number;
}): Promise<void> {
  if (params.deliveredQty <= 0) return;

  const cur = await bestStatus(params.serviceId);
  if (cur === null) return;
  if (cur === "DEAD") return; // operator must revive() first

  // QUALIFIED → MONITORED needs the retest signal: this service
  // has been tested more than once. We count distinct TestOrders
  // for the service.
  if (cur === "QUALIFIED") {
    const orderCount = await prisma.testOrder.count({
      where: { serviceId: params.serviceId },
    });
    if (orderCount >= 2) {
      await prisma.productServiceCandidate.updateMany({
        where: {
          serviceId: params.serviceId,
          lifecycleStatus: "QUALIFIED",
        },
        data: { lifecycleStatus: "MONITORED" },
      });
    }
    return;
  }

  if (cur === "MONITORED") return; // already at the steady state

  // cur is NEW or TESTING — first delivery signal → QUALIFIED.
  // Use ≥2 orders to skip straight to MONITORED if the test has
  // already been retested before delivery showed up.
  const orderCount = await prisma.testOrder.count({
    where: { serviceId: params.serviceId },
  });
  const next: LifecycleStatus = orderCount >= 2 ? "MONITORED" : "QUALIFIED";
  await prisma.productServiceCandidate.updateMany({
    where: {
      serviceId: params.serviceId,
      lifecycleStatus: { in: ["NEW", "TESTING"] },
    },
    data: { lifecycleStatus: next },
  });
}

// Called by the poller when a TestOrder transitions to
// completed/aborted. Decides whether to fire a DEAD transition:
//   • TESTING + age ≥ 7d + no delivery EVER → DEAD (sunset)
//   • QUALIFIED/MONITORED + last 2 retests delivered 0 → DEAD
// QUALIFICATION up-transitions are handled by onMeasurementWritten
// above so this function is purely terminal-state work.
export async function onTestCompleted(params: {
  serviceId: number;
  testOrderId: number;
  deliveredQty: number;
}): Promise<{
  transition: "DEAD" | "no_change";
  reason?: string;
}> {
  const toggles = await getSystemToggles();
  if (!toggles.autoKillDeadServicesEnabled) return { transition: "no_change" };

  const cur = await bestStatus(params.serviceId);
  if (cur === null || cur === "DEAD") return { transition: "no_change" };

  // ── Path 1: TESTING + T+7d sunset ────────────────────────────
  // Initial test never delivered. Wait the full window before
  // killing — BulkMedya providers can be slow.
  if (cur === "NEW" || cur === "TESTING") {
    if (params.deliveredQty > 0) return { transition: "no_change" };
    // Has the service EVER had a delivery on any of its TestOrders?
    // If yes, the per-poll qualifier should have already promoted
    // it; we still recheck to be defensive against missed hooks.
    const everDelivered = await serviceEverDelivered(params.serviceId);
    if (everDelivered) {
      // Belt-and-braces: re-trigger the up-transition so the
      // candidate row matches reality.
      await onMeasurementWritten({
        serviceId: params.serviceId,
        deliveredQty: 1,
      });
      return { transition: "no_change" };
    }
    // Compute the oldest order's age. We use OLDEST instead of
    // THIS order's age because retries / re-placement chains can
    // produce a fresh order on a service that's been TESTING for
    // 6+ days; the meaningful "give up" signal is "this service
    // has been failing to deliver for a week".
    const oldest = await prisma.testOrder.findFirst({
      where: { serviceId: params.serviceId },
      orderBy: { placedAt: "asc" },
      select: { placedAt: true },
    });
    if (!oldest) return { transition: "no_change" };
    const ageMs = Date.now() - oldest.placedAt.getTime();
    if (ageMs < 7 * 24 * 60 * 60_000) {
      return { transition: "no_change" };
    }
    await killService(params.serviceId, "no_delivery_at_t_plus_7d");
    return { transition: "DEAD", reason: "T+7d sunset, no delivery" };
  }

  // ── Path 2: QUALIFIED/MONITORED + 3 consecutive zero retests ─
  // Only kicks in for services that ALREADY delivered at least
  // once. With the 3×/day retest cadence (every 8h), the prior
  // 2-fail threshold made an 8h provider blip lethal — too
  // brittle. Bumped to 3 so a kill needs ~24h of continuous
  // failure to fire, while still catching a genuinely dead
  // provider within a single day.
  if (cur === "QUALIFIED" || cur === "MONITORED") {
    const lastThree = await prisma.testOrder.findMany({
      where: {
        serviceId: params.serviceId,
        status: {
          in: [
            "completed",
            "completed_partial",
            "aborted_target_died",
            "aborted_other",
          ],
        },
      },
      include: { measurements: true },
      orderBy: { completedAt: "desc" },
      take: 3,
    });
    if (lastThree.length < 3) return { transition: "no_change" };
    const allZero = lastThree.every((o) => {
      const peak = Math.max(
        o.baselineCount,
        ...o.measurements.map((m) => m.actualCount)
      );
      return peak <= o.baselineCount;
    });
    if (!allZero) return { transition: "no_change" };
    await killService(params.serviceId, "auto_no_delivery_3x_retest");
    return { transition: "DEAD", reason: "3 consecutive zero retests" };
  }

  return { transition: "no_change" };
}

// Best-effort scan: does ANY of the service's TestOrders have a
// Measurement with actualCount > baselineCount?
async function serviceEverDelivered(serviceId: number): Promise<boolean> {
  const orders = await prisma.testOrder.findMany({
    where: { serviceId },
    select: { baselineCount: true, measurements: { select: { actualCount: true } } },
  });
  for (const o of orders) {
    const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
    if (peak > o.baselineCount) return true;
  }
  return false;
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
  // Alert.code isn't unique so we findFirst + update-or-create.
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
          description: reason.startsWith("no_delivery_at_t_plus_7d")
            ? "Aucune livraison mesurée après 7 jours — service retiré du catalogue routable."
            : "3 retests consécutifs sans livraison — service retiré du catalogue routable.",
          explanation: `Lifecycle coordinator: ${reason}. Le service avait ${reason.startsWith("auto_no_delivery_3x_retest") ? "déjà délivré au moins une fois (QUALIFIED/MONITORED) puis échoué 3 retests d'affilée" : "dépassé 7 jours sans aucune livraison RapidAPI mesurée"}. active=false pour écarter du routage, lifecycleStatus=DEAD sur toutes les candidacies.`,
          impact: "Le service n'est plus routable et ne sera plus retesté automatiquement.",
          suggestedAction: "Ouvrir /config/catalogue, cliquer REVIVE si besoin de retester (le service repassera en TESTING).",
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
    /* alert is best-effort; the kill itself already landed */
  }
}

// Operator revival — DEAD → TESTING (we drop QUALIFIED/MONITORED
// status because the historic delivery signal might be stale).
// The next placement will trigger qualification per the normal
// rules.
export async function reviveService(serviceId: number): Promise<void> {
  await prisma.service.update({
    where: { id: serviceId },
    data: { active: true },
  });
  await prisma.productServiceCandidate.updateMany({
    where: { serviceId, lifecycleStatus: "DEAD" },
    data: { lifecycleStatus: "TESTING", isEligible: true },
  });
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

// Counts for the dashboard CYCLE DE VIE CATALOGUE card. De-duped
// per service — "best status" wins so a service with mixed
// candidacies counts once in its highest bucket.
export async function lifecycleCounts(): Promise<Record<LifecycleStatus, number>> {
  const out: Record<LifecycleStatus, number> = {
    NEW: 0,
    TESTING: 0,
    QUALIFIED: 0,
    MONITORED: 0,
    DEAD: 0,
    PLACEMENT_FAILED: 0,
    REMOVED_FROM_BULKMEDYA: 0,
    PERMANENTLY_FAILED: 0,
    DEPRECATED_PRODUCT: 0,
  };
  const rows = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const best = new Map<number, LifecycleStatus>();
  for (const r of rows) {
    const cur = best.get(r.serviceId);
    const next = r.lifecycleStatus as LifecycleStatus;
    if (!cur || RANK[next] > RANK[cur]) best.set(r.serviceId, next);
  }
  for (const v of Array.from(best.values())) out[v]++;
  return out;
}

// Backfill helper — drives existing candidacies into the new
// lifecycle states based on the actual TestOrder + Measurement
// history. Idempotent. Replaces the legacy backfill that used
// score+active heuristics.
export async function backfillLifecycle(): Promise<{
  inspected: number;
  promotedToQualified: number;
  promotedToMonitored: number;
  demotedFromMonitored: number;
  revivedFromDead: number;
  killedAtT7d: number;
  unchanged: number;
}> {
  const result = {
    inspected: 0,
    promotedToQualified: 0,
    promotedToMonitored: 0,
    demotedFromMonitored: 0,
    revivedFromDead: 0,
    killedAtT7d: 0,
    unchanged: 0,
  };

  // De-duped service list with current best status.
  const all = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const best = new Map<number, LifecycleStatus>();
  for (const r of all) {
    const cur = best.get(r.serviceId);
    const next = r.lifecycleStatus as LifecycleStatus;
    if (!cur || RANK[next] > RANK[cur]) best.set(r.serviceId, next);
  }
  result.inspected = best.size;

  for (const [serviceId, status] of Array.from(best.entries())) {
    // Compute the truths once per service.
    const orders = await prisma.testOrder.findMany({
      where: { serviceId },
      include: { measurements: true },
      orderBy: { placedAt: "asc" },
    });
    const everDelivered = orders.some((o) => {
      const peak = Math.max(
        o.baselineCount,
        ...o.measurements.map((m) => m.actualCount)
      );
      return peak > o.baselineCount;
    });
    const oldestAgeMs = orders.length > 0
      ? Date.now() - orders[0].placedAt.getTime()
      : 0;
    const orderCount = orders.length;

    if (status === "MONITORED") {
      if (!everDelivered) {
        // Bogus MONITORED — demote. If service has any test, it's
        // TESTING; otherwise NEW.
        const target: LifecycleStatus = orderCount > 0 ? "TESTING" : "NEW";
        await prisma.productServiceCandidate.updateMany({
          where: { serviceId },
          data: { lifecycleStatus: target },
        });
        result.demotedFromMonitored++;
        continue;
      }
      result.unchanged++;
      continue;
    }

    if (status === "DEAD") {
      // Premature kill if oldest TestOrder < 7d old AND no delivery.
      // Wait — actually we revive on the AGE criterion alone, since
      // the real DEAD rule is "T+7d AND no delivery". If a DEAD row
      // had delivery, it was killed by 2-consecutive-zero-rule on
      // retests; that's a valid DEAD.
      if (orderCount === 0 || oldestAgeMs < 7 * 24 * 60 * 60_000) {
        if (!everDelivered) {
          // Premature DEAD — revive to TESTING.
          await prisma.service.update({
            where: { id: serviceId },
            data: { active: true },
          });
          await prisma.productServiceCandidate.updateMany({
            where: { serviceId },
            data: {
              lifecycleStatus: orderCount > 0 ? "TESTING" : "NEW",
              isEligible: true,
            },
          });
          await prisma.alert
            .updateMany({
              where: {
                code: `service_killed_no_delivery:${serviceId}`,
                status: { in: ["active", "acknowledged"] },
              },
              data: { status: "resolved", resolvedAt: new Date() },
            })
            .catch(() => null);
          result.revivedFromDead++;
          continue;
        }
      }
      result.unchanged++;
      continue;
    }

    if (status === "TESTING" || status === "NEW") {
      if (everDelivered) {
        // Should be QUALIFIED (or MONITORED if retested already).
        const target: LifecycleStatus = orderCount >= 2 ? "MONITORED" : "QUALIFIED";
        await prisma.productServiceCandidate.updateMany({
          where: { serviceId },
          data: { lifecycleStatus: target },
        });
        if (target === "QUALIFIED") result.promotedToQualified++;
        else result.promotedToMonitored++;
        continue;
      }
      // No delivery yet. If oldest order ≥ 7d, kill via T+7d rule.
      if (orderCount > 0 && oldestAgeMs >= 7 * 24 * 60 * 60_000) {
        await killService(serviceId, "no_delivery_at_t_plus_7d");
        result.killedAtT7d++;
        continue;
      }
      result.unchanged++;
      continue;
    }

    if (status === "QUALIFIED") {
      // QUALIFIED with ≥2 orders → promote MONITORED; otherwise
      // leave as-is.
      if (orderCount >= 2) {
        await prisma.productServiceCandidate.updateMany({
          where: { serviceId, lifecycleStatus: "QUALIFIED" },
          data: { lifecycleStatus: "MONITORED" },
        });
        result.promotedToMonitored++;
        continue;
      }
      result.unchanged++;
      continue;
    }

    result.unchanged++;
  }

  return result;
}
