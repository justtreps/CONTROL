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
import { withApiKey } from "@/lib/rapidapi/key-manager";
import { testCostUsd } from "./test-quantity";

// BATCH_SIZE = placements attempted per cron tick.
// CONCURRENCY = parallel placements in flight inside a tick.
//
// With 2 active RapidAPI keys and the per-key rate limiter at 85
// req/min each, aggregate IG throughput = 170 req/min. A
// placement needs ~2 RapidAPI calls (oracle + follower snapshot),
// so the ceiling is ~85 placements/min. CONCURRENCY=5 keeps 5
// placements in flight at once, spread across keys via
// withApiKey's ALS wrap + round-robin, so the rate limiter is the
// one that paces us instead of sequential DB/BulkMedya waits.
//
// BATCH_SIZE=50 × tick every 1 min = 3000/h theoretical ceiling.
// Observed ~1000-1500/h (bounded by RapidAPI + BulkMedya
// responsiveness). 3 271 services → ~2-3 h. Matches the target.
const BATCH_SIZE = 50;
const CONCURRENCY = 5;
const FLUSH_EVERY_WAVE = true; // write campaign progress after each concurrent wave
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
          maxQuantity: true,
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
    maxQuantity: number;
    ratePerK: number;
    cost: number;
  }> = [];
  const skipped: Array<{ id: number; cost: number }> = [];
  for (const c of cands) {
    if (!c.service || seen.has(c.service.id)) continue;
    seen.add(c.service.id);
    // Cost uses the floored test quantity (max(20, minQuantity)).
    // Returns null when service.maxQuantity < 20 — silent skip.
    const cost = testCostUsd(c.service);
    if (cost === null) continue;
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

  // Standard runner skips brute-mode campaigns — those are
  // handled by /api/cron/brute-campaign-runner with raw BulkMedya
  // placement (no oracle / health / country pre-checks).
  const campaign = await prisma.scoringCampaign.findFirst({
    where: {
      status: "running",
      NOT: { stopReason: "brute_mode" },
    },
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

  // Round-robin the active keys across placements so the per-key
  // rate limiter is the effective bottleneck (170/min with 2 keys)
  // rather than serialising everything through one key's 85/min.
  const activeKeys = await prisma.rapidApiKey.findMany({
    where: { provider: "instagram", status: "active" },
    orderBy: { id: "asc" },
  });

  // Flush helper — persists the live accumulated progress so a
  // timeout mid-loop doesn't lose work. One row update, no joins.
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

  // Process the batch in waves of CONCURRENCY. Inside each wave,
  // Promise.all fires all placements in parallel; the per-key rate
  // limiter serialises RapidAPI calls automatically.
  const placeOne = async (sid: number, waveIdx: number) => {
    const svc = byId.get(sid);
    if (!svc) {
      placed.add(sid);
      result.skipped++;
      return;
    }
    // Assign a key round-robin by wave index. withApiKey seeds ALS
    // so every IG call under the wrap uses this key. When no DB
    // keys are available (env-var fallback path) we skip the wrap
    // and let instagram.ts fall back to the config key.
    const key = activeKeys.length
      ? activeKeys[waveIdx % activeKeys.length]
      : null;
    const doPlace = async () => {
      // retry_private / oracle_error = the picked pool entity was
      // dead (private, ghost, transient oracle hiccup). Don't burn
      // the service on a bad pool pick — try again with a fresh
      // entity up to MAX_RETRY_PRIVATE times. Only counts toward
      // placement throughput if we run out of retries; otherwise
      // recover silently.
      const MAX_RETRY_PRIVATE = 3;
      for (let attempt = 0; attempt <= MAX_RETRY_PRIVATE; attempt++) {
        try {
          const outcome = await attemptPlaceOrder({
            service: svc as Service,
            simulated,
          });
          if (outcome.kind === "placed") {
            result.placed++;
            placed.add(sid);
            return;
          }
          if (outcome.kind === "no_account") {
            // Pool empty — don't mark placed so a later campaign
            // re-queues it when the pool refills.
            result.skipped++;
            return;
          }
          if (outcome.kind === "retry_private") {
            // Bad pool entity (private / ghost). Loop to pick a
            // fresh one — attemptPlaceOrder already invalidated the
            // dead account so pickAndAssignAccount will skip it.
            if (attempt < MAX_RETRY_PRIVATE) continue;
            // Exhausted retries — finally abort.
            result.aborted++;
            placed.add(sid);
            return;
          }
          // outcome.kind === "skip" — upstream error or BulkMedya
          // rejection. Retry once on oracle_error transients only;
          // BulkMedya rejections are terminal (service.died was
          // emitted, don't hammer).
          const skipReason = (outcome as { reason: string }).reason;
          if (attempt < 1 && skipReason.startsWith("oracle_error")) continue;
          result.aborted++;
          placed.add(sid);
          return;
        } catch (e) {
          const msg = (e as Error).message.slice(0, 160);
          console.warn(`[campaign] service#${sid} placement threw:`, msg);
          // Transient network/RapidAPI error — retry once. Second
          // throw gives up.
          if (attempt < 1) continue;
          result.aborted++;
          placed.add(sid);
          return;
        }
      }
    };
    if (key) {
      await withApiKey(
        { id: key.id, token: key.token, provider: key.provider },
        undefined,
        doPlace
      );
    } else {
      await doPlace();
    }
  };

  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const wave = batch.slice(i, i + CONCURRENCY);
    await Promise.all(wave.map((sid, j) => placeOne(sid, i + j)));
    if (FLUSH_EVERY_WAVE) await flush();
  }
  // Final flush guarantees the last wave lands.
  await flush();

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

  const minutesElapsed = Math.max(
    1,
    (Date.now() - c.startedAt.getTime()) / 60_000
  );
  const placedSoFar = c.placedServiceIds.length;
  const target = c.targetServiceIds.length;

  // PLACEMENT metrics — how long until we've dispatched every test.
  // This is the operator-facing progress bar: "when does the
  // placement phase finish". Separate from the completion window
  // which is dominated by T+7 d polling of real BulkMedya deliveries.
  const placementRatePerMin = placedSoFar / minutesElapsed;
  const placementRatePerHour = Math.round(placementRatePerMin * 60);
  const remaining = target - placedSoFar;
  const placementEtaMinutes =
    placementRatePerMin > 0
      ? Math.round(remaining / placementRatePerMin)
      : null;

  // COMPLETION ETA — placement + T+7d polling window. The last
  // test placed triggers a 7 d (=10 080 min) wait for the
  // adaptive poller to finalise it. Total ≈ placementEta + 10 080.
  const completionEtaMinutes =
    placementEtaMinutes !== null ? placementEtaMinutes + 7 * 24 * 60 : null;

  const placedRatio = target > 0 ? placedSoFar / target : 0;
  const accumulatedCostUsd = c.estimatedCostUsd
    ? Math.round(c.estimatedCostUsd * placedRatio * 100) / 100
    : null;

  return {
    id: c.id,
    status: c.status,
    startedAt: c.startedAt.toISOString(),
    finishedAt: c.finishedAt?.toISOString() ?? null,
    stopReason: c.stopReason,
    targetCount: target,
    placedCount: placedSoFar,
    placedPlacedCount: c.placedCount,
    abortedCount: c.abortedCount,
    estimatedCostUsd: c.estimatedCostUsd,
    accumulatedCostUsd,
    // Legacy field — clients still read this; point it at the
    // placement ETA which is the operationally relevant number.
    etaMinutes: placementEtaMinutes,
    placementEtaMinutes,
    completionEtaMinutes,
    placementRatePerHour,
    remaining,
  };
}
