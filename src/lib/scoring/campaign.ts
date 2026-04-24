// Mass scoring campaign — plan + tick runner + safety guards.
//
// Plan (launchCampaign):
//   1. Snapshot the list of ProductServiceCandidate.serviceId where
//      isEligible=true AND forceExcluded=false AND the service has
//      never been tested OR lastTestedAt is older than 7 days.
//   2. De-dupe by serviceId (a service can be a candidate for
//      multiple products).
//   3. Compute an estimated cost = Σ(service.ratePerK × minQuantity
//      / 1000) for the full list. Store on the campaign row for UI
//      display + post-run reconciliation.
//   4. Create the campaign with status='running'.
//
// Tick (runCampaignTick):
//   1. Pick the single oldest running campaign. No-op if none.
//   2. Run safety checks — quota ≥ 95 %, BulkMedya balance signal,
//      abort burst. Stop campaign + return stopReason on any hit.
//   3. Pick up to BATCH_SIZE service IDs from targetServiceIds
//      that aren't already in placedServiceIds (no repeats). Also
//      respects the pool availability: skip services whose
//      accountType pool is empty.
//   4. For each service, reuse testbot.ts:attemptPlaceOrder. Track
//      placed / aborted counters. Append serviceId to
//      placedServiceIds atomically so a crashed tick doesn't
//      re-place.
//   5. When placedServiceIds.length >= targetServiceIds.length,
//      mark campaign as 'completed' + finishedAt.

import type { Prisma, Service } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { attemptPlaceOrder } from "@/lib/testbot";
import { getSystemToggles } from "@/lib/system/toggles";

// 10 placements per tick — each runs ~8-10 s wall time through the
// oracle + realism sample + BulkMedya + DB path. 10 × 10 s = ~100 s,
// comfortably under the 300 s cron budget. 10/min × 60 = 600/h so
// a 3 300-service campaign lands in ~5 h 30. Slower than the target
// 1 h but safer: individual ticks never hit the timeout so the
// progressive flush below doesn't need to race anyone.
const BATCH_SIZE = 10;
const FLUSH_EVERY = 1; // write campaign progress after every placement
const QUOTA_STOP_RATIO = 0.95;
const ABORT_BURST_MAX = 50;
const ABORT_BURST_WINDOW_MS = 60 * 60_000;

export type SafetyOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export async function runSafetyChecks(
  campaignId: number
): Promise<SafetyOutcome> {
  // (a) Any active RapidApiKey quotaUsed ≥ 95 % ?
  const keys = await prisma.rapidApiKey.findMany({
    where: { provider: "instagram", status: "active" },
  });
  for (const k of keys) {
    if (!k.quotaMonthly) continue;
    if (k.quotaUsed / k.quotaMonthly >= QUOTA_STOP_RATIO) {
      return {
        ok: false,
        reason: `quota_${Math.round(QUOTA_STOP_RATIO * 100)}pct_key_${k.id}`,
      };
    }
  }
  // (b) BulkMedya balance_insufficient — can only be detected by
  //     observing a failed placement. We scan the last 20 min of
  //     TestOrder abortReason / RoutingDecision.errorMessage for
  //     the marker string.
  const recentFails = await prisma.routingDecision.findMany({
    where: {
      decidedAt: { gte: new Date(Date.now() - 20 * 60_000) },
      success: false,
      errorMessage: { contains: "balance" },
    },
    select: { id: true },
  });
  if (recentFails.length > 0) {
    return { ok: false, reason: "balance_insufficient" };
  }
  // (c) Abort burst: > 50 aborted_target_died in the last hour on
  //     this campaign's window.
  const campaign = await prisma.scoringCampaign.findUnique({
    where: { id: campaignId },
  });
  if (!campaign) return { ok: false, reason: "campaign_not_found" };
  const recentAborts = await prisma.testOrder.count({
    where: {
      status: "aborted_target_died",
      placedAt: { gte: new Date(Date.now() - ABORT_BURST_WINDOW_MS) },
      serviceId: { in: campaign.targetServiceIds },
    },
  });
  if (recentAborts > ABORT_BURST_MAX) {
    return { ok: false, reason: `abort_burst_${recentAborts}` };
  }
  return { ok: true };
}

export type CampaignPlan = {
  campaignId: number;
  servicesQueued: number;
  estimatedCostUsd: number;
  skippedExpensive: number;
  skippedExpensiveCostUsd: number;
};

const DEFAULT_MAX_COST_PER_TEST_USD = 5;

export async function launchCampaign(opts: {
  includeStaleOlderThanDays?: number; // 7 by default
  // Hard safety cap on per-test cost (= ratePerK × minQuantity /
  // 1000). BulkMedya has a handful of "ADS" services with
  // minQuantity = 1 M units → $350+ per single test. Those skew
  // the total + are inappropriate for mass scoring. Services above
  // this cap are skipped; the response carries the count + what
  // they would have added to the bill. Default $5.
  maxCostPerTestUsd?: number;
} = {}): Promise<CampaignPlan | { error: string }> {
  const existing = await prisma.scoringCampaign.findFirst({
    where: { status: { in: ["running", "paused"] } },
  });
  if (existing) {
    return { error: `campaign_already_running:${existing.id}` };
  }

  const staleCutoff = new Date(
    Date.now() -
      (opts.includeStaleOlderThanDays ?? 7) * 24 * 3600 * 1000
  );

  // Pull eligible candidates whose service is active + (never tested
  // OR stale). Group by serviceId to de-dup.
  const cands = await prisma.productServiceCandidate.findMany({
    where: {
      isEligible: true,
      forceExcluded: false,
      service: {
        active: true,
        OR: [
          { lastTestedAt: null },
          { lastTestedAt: { lt: staleCutoff } },
        ],
      },
    },
    include: {
      service: {
        select: {
          id: true,
          minQuantity: true,
          ratePerK: true,
        },
      },
    },
  });
  const maxCost = opts.maxCostPerTestUsd ?? DEFAULT_MAX_COST_PER_TEST_USD;
  const seen = new Set<number>();
  const svcList: Array<{
    id: number;
    minQuantity: number;
    ratePerK: number;
    cost: number;
  }> = [];
  const skipped: Array<{ id: number; cost: number }> = [];
  for (const c of cands) {
    if (!c.service || seen.has(c.service.id)) continue;
    seen.add(c.service.id);
    const cost = (c.service.ratePerK * c.service.minQuantity) / 1000;
    if (cost > maxCost) {
      skipped.push({ id: c.service.id, cost });
      continue;
    }
    svcList.push({ ...c.service, cost });
  }

  if (svcList.length === 0) {
    return { error: "no_services_to_test" };
  }

  const estimatedCostUsd =
    Math.round(svcList.reduce((a, s) => a + s.cost, 0) * 100) / 100;
  const skippedExpensiveCostUsd =
    Math.round(skipped.reduce((a, s) => a + s.cost, 0) * 100) / 100;

  const campaign = await prisma.scoringCampaign.create({
    data: {
      status: "running",
      targetServiceIds: svcList.map((s) => s.id),
      estimatedCostUsd,
    },
  });

  return {
    campaignId: campaign.id,
    servicesQueued: svcList.length,
    estimatedCostUsd,
    skippedExpensive: skipped.length,
    skippedExpensiveCostUsd,
  };
}

export type TickResult = {
  campaignId: number | null;
  placed: number;
  skipped: number;
  aborted: number;
  remaining: number;
  stopped?: string;
};

export async function runCampaignTick(): Promise<TickResult> {
  const result: TickResult = {
    campaignId: null,
    placed: 0,
    skipped: 0,
    aborted: 0,
    remaining: 0,
  };

  const campaign = await prisma.scoringCampaign.findFirst({
    where: { status: "running" },
    orderBy: { startedAt: "asc" },
  });
  if (!campaign) return result;

  result.campaignId = campaign.id;

  const safety = await runSafetyChecks(campaign.id);
  if (!safety.ok) {
    await prisma.scoringCampaign.update({
      where: { id: campaign.id },
      data: {
        status: "stopped_safety",
        stopReason: safety.reason,
        finishedAt: new Date(),
      },
    });
    result.stopped = safety.reason;
    return result;
  }

  // Gate on testbot master kill switch too — if the operator
  // paused the test-bot, we shouldn't be spending campaign budget
  // either.
  const toggles = await getSystemToggles();
  if (!toggles.testBotEnabled) {
    result.stopped = "testbot_disabled";
    return result;
  }

  const placed = new Set(campaign.placedServiceIds);
  const pending = campaign.targetServiceIds.filter((id) => !placed.has(id));
  result.remaining = pending.length;

  if (pending.length === 0) {
    await prisma.scoringCampaign.update({
      where: { id: campaign.id },
      data: { status: "completed", finishedAt: new Date() },
    });
    return result;
  }

  const batch = pending.slice(0, BATCH_SIZE);
  // Preload Service rows in one round-trip to avoid a per-id query.
  const services = await prisma.service.findMany({
    where: { id: { in: batch } },
  });
  const byId = new Map(services.map((s) => [s.id, s]));

  const simulated = toggles.dryRunMode; // respect dry-run

  // Flush helper — writes the live accumulated progress to DB so a
  // timeout mid-loop doesn't lose work. Called after every placement
  // (FLUSH_EVERY=1). Cheap: a single row update, no joins.
  const flush = async () => {
    await prisma.scoringCampaign.update({
      where: { id: campaign.id },
      data: {
        placedServiceIds: Array.from(placed) as unknown as Prisma.InputJsonValue as number[],
        placedCount: campaign.placedCount + result.placed,
        abortedCount: campaign.abortedCount + result.aborted,
        ...(placed.size >= campaign.targetServiceIds.length
          ? { status: "completed", finishedAt: new Date() }
          : {}),
      },
    });
  };

  let sincelastFlush = 0;
  for (const sid of batch) {
    const svc = byId.get(sid);
    if (!svc) {
      placed.add(sid);
      result.skipped++;
      sincelastFlush++;
      if (sincelastFlush >= FLUSH_EVERY) {
        await flush();
        sincelastFlush = 0;
      }
      continue;
    }
    try {
      const outcome = await attemptPlaceOrder({
        service: svc as Service,
        simulated,
      });
      if (outcome.kind === "placed") {
        result.placed++;
      } else if (outcome.kind === "no_account") {
        // Pool empty — skip this service, don't mark placed so the
        // next campaign re-queues it when the pool refills.
        result.skipped++;
        continue;
      } else if (outcome.kind === "retry_private") {
        result.aborted++;
      } else {
        result.aborted++;
      }
      placed.add(sid);
    } catch (e) {
      result.aborted++;
      console.warn(
        `[campaign] service#${sid} placement threw:`,
        (e as Error).message.slice(0, 160)
      );
      // Mark placed anyway so we don't infinite-loop on a single
      // broken service.
      placed.add(sid);
    }
    sincelastFlush++;
    if (sincelastFlush >= FLUSH_EVERY) {
      await flush();
      sincelastFlush = 0;
    }
  }
  // Final flush for any trailing placements not yet persisted.
  if (sincelastFlush > 0) await flush();

  result.remaining = campaign.targetServiceIds.length - placed.size;
  return result;
}

// Helper the dashboard calls to render the live campaign card.
export async function getActiveCampaign() {
  const c = await prisma.scoringCampaign.findFirst({
    where: { status: { in: ["running", "paused"] } },
    orderBy: { startedAt: "desc" },
  });
  if (!c) return null;

  // Completion rate + ETA estimation. Linear: remaining /
  // (placed per minute). placed per min = placedCount / minutes
  // elapsed. Null when placedCount is still 0.
  const minutesElapsed = Math.max(
    1,
    (Date.now() - c.startedAt.getTime()) / 60_000
  );
  const rate = c.placedCount / minutesElapsed;
  const remaining = c.targetServiceIds.length - c.placedServiceIds.length;
  const etaMinutes = rate > 0 ? Math.round(remaining / rate) : null;

  // Accumulated cost: share of the estimated cost that matches the
  // fraction of placed services. Approximate (each service has its
  // own minQuantity × ratePerK), but good enough for the progress
  // card.
  const placedRatio =
    c.targetServiceIds.length > 0
      ? c.placedServiceIds.length / c.targetServiceIds.length
      : 0;
  const accumulatedCostUsd = c.estimatedCostUsd
    ? Math.round(c.estimatedCostUsd * placedRatio * 100) / 100
    : null;

  return {
    id: c.id,
    status: c.status,
    startedAt: c.startedAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
    stopReason: c.stopReason,
    targetCount: c.targetServiceIds.length,
    placedCount: c.placedServiceIds.length,
    placedPlacedCount: c.placedCount,
    abortedCount: c.abortedCount,
    estimatedCostUsd: c.estimatedCostUsd,
    accumulatedCostUsd,
    etaMinutes,
    remaining,
  };
}
