// BRUTE-FORCE PLACEMENT CAMPAIGN.
//
// Hits every NEW eligible service with one real BulkMedya order.
// Zero pre-checks: no oracle call, no fetchFollowerSnapshot, no
// country filter, no private-flip guard, no auto-retry on dead
// pool entities. Just:
//
//   1. SELECT first available pool entity (account for follower
//      services, post for engagement) — peu importe son état
//   2. POST BulkMedya.addOrder with the cached username/url
//   3. INSERT TestOrder + Measurement(T+0) using the cached
//      lastFollowerCount as baseline
//   4. lifecycleStatus = TESTING
//
// On BulkMedya rejection: lifecycleStatus = PLACEMENT_FAILED
// (distinct state — not DEAD, not back-to-NEW). Service is
// excluded from the scoring routing pool but stays auditable.
//
// Cost cap: maxCostPerTestUsd ($5 default) skips the mega-min ADS
// SKUs from the catalogue snapshot. That's the ONLY filter — if a
// service costs ≤ $5 to test, it ships.
//
// Concurrency: 50 placements per wave (CONCURRENCY_BRUTE).
// BATCH_SIZE_BRUTE caps per-tick processing so a single Vercel
// cron run stays under the 300s budget. With 2762 services, a
// 1-min cron at BATCH=200 finishes in ~14 ticks (≤ 15 min).

import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";
import { getSystemToggles } from "@/lib/system/toggles";
import { flushUsage, withApiKey } from "@/lib/rapidapi/key-manager";
import { testCostUsd, testQuantityFor } from "./test-quantity";

const DEFAULT_MAX_COST_USD = 5;
const BATCH_SIZE_BRUTE = 200;
const CONCURRENCY_BRUTE = 50;
const FLUSH_EVERY_WAVE = true;
const BRUTE_MARKER = "brute_mode";

export type BruteLaunchResult = {
  campaignId: number;
  totalServices: number;
  estimatedCostUsd: number;
  skippedExpensive: number;
  skippedExpensiveCostUsd: number;
};

export type BruteTickResult = {
  campaignId: number | null;
  placed: number;
  failed: number;
  skipped: number;
  remaining: number;
  done: boolean;
  stopped?: string;
};

// ── Launch ─────────────────────────────────────────────────────

export async function launchBruteCampaign(opts: {
  maxCostPerTestUsd?: number;
} = {}): Promise<BruteLaunchResult | { error: string }> {
  // Snapshot the NEW eligible services. We don't filter by
  // service.active because the user wants ALL NEW — even ones
  // marked active=false get considered.
  const cands = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: "NEW",
      isEligible: true,
      forceExcluded: false,
    },
    include: {
      service: {
        select: {
          id: true,
          minQuantity: true,
          maxQuantity: true,
          ratePerK: true,
          active: true,
        },
      },
    },
  });
  const maxCost = opts.maxCostPerTestUsd ?? DEFAULT_MAX_COST_USD;
  const seen = new Set<number>();
  const accepted: number[] = [];
  const skipped: Array<{ id: number; cost: number }> = [];
  let totalCost = 0;
  for (const c of cands) {
    if (!c.service || !c.service.active) continue;
    if (seen.has(c.service.id)) continue;
    seen.add(c.service.id);
    // Cost uses the floored test quantity (max(20, minQuantity))
    // so the budget estimate matches what's actually placed.
    // Returns null when maxQuantity < 20 — skip those.
    const cost = testCostUsd(c.service);
    if (cost === null) continue;
    if (cost > maxCost) {
      skipped.push({ id: c.service.id, cost });
      continue;
    }
    accepted.push(c.service.id);
    totalCost += cost;
  }
  if (accepted.length === 0) return { error: "no_new_services_to_test" };

  const campaign = await prisma.scoringCampaign.create({
    data: {
      status: "running",
      stopReason: BRUTE_MARKER, // marker so the standard runner skips
      targetServiceIds: accepted,
      estimatedCostUsd: Math.round(totalCost * 100) / 100,
    },
  });

  return {
    campaignId: campaign.id,
    totalServices: accepted.length,
    estimatedCostUsd: Math.round(totalCost * 100) / 100,
    skippedExpensive: skipped.length,
    skippedExpensiveCostUsd:
      Math.round(skipped.reduce((a, s) => a + s.cost, 0) * 100) / 100,
  };
}

// ── Brute placement (single service) ───────────────────────────

type BruteOutcome =
  | { kind: "placed"; testOrderId: number }
  | { kind: "no_pool" }
  | { kind: "bulkmedya_failed"; reason: string }
  | { kind: "thrown"; reason: string };

async function placeBruteOne(serviceId: number): Promise<BruteOutcome> {
  try {
    const service = await prisma.service.findUnique({
      where: { id: serviceId },
      select: {
        id: true,
        platform: true,
        bulkmedyaId: true,
        minQuantity: true,
        maxQuantity: true,
        poolType: true,
      },
    });
    if (!service) return { kind: "thrown", reason: "service_not_found" };
    const testQty = testQuantityFor(service);
    if (testQty === null) {
      return { kind: "thrown", reason: `max_below_floor:${service.maxQuantity}` };
    }

    const isEngagement = service.poolType === "engagement_test";

    // Pick the FIRST available pool entity. No country filter, no
    // confidence filter — peu importe son état du moment qu'il
    // est marqué available + active.
    let username = "";
    let baseFollower = 0;
    let testAccountId = 0;
    let postId: number | null = null;
    let bulkLink = "";

    // Compare-and-swap loop — the previous version used
    // findFirst-then-update where {id} only, which let 50 concurrent
    // brute calls all see the same first-available row and all
    // "succeed" the update because the where-clause didn't pin
    // status. Result: same testAccount on N TestOrders simultaneously
    // (observed: account#94 stamped on TO#5618-5624). The CAS pins
    // status='available' so only one caller wins; the rest re-roll.
    const MAX_BRUTE_PICK_ATTEMPTS = 8;
    if (isEngagement) {
      let claimed = false;
      for (let attempt = 0; attempt < MAX_BRUTE_PICK_ATTEMPTS && !claimed; attempt++) {
        const post = await prisma.testPost.findFirst({
          where: { status: "available", platform: service.platform },
          include: { testAccount: true },
          orderBy: { firstSeenAt: "asc" },
        });
        if (!post) return { kind: "no_pool" };
        const claim = await prisma.testPost.updateMany({
          where: { id: post.id, status: "available" },
          data: { status: "assigned", assignedAt: new Date() },
        });
        if (claim.count === 0) continue;
        username = post.testAccount.username;
        baseFollower = post.testAccount.lastFollowerCount ?? 0;
        testAccountId = post.testAccountId;
        postId = post.id;
        bulkLink = post.mediaUrl;
        claimed = true;
      }
      if (!claimed) return { kind: "no_pool" };
    } else {
      let claimed = false;
      for (let attempt = 0; attempt < MAX_BRUTE_PICK_ATTEMPTS && !claimed; attempt++) {
        const account = await prisma.testAccount.findFirst({
          where: {
            status: "available",
            platform: service.platform,
            accountType: "follower_test",
          },
          orderBy: { firstSeenAt: "asc" },
        });
        if (!account) return { kind: "no_pool" };
        const claim = await prisma.testAccount.updateMany({
          where: { id: account.id, status: "available" },
          data: {
            status: "assigned",
            assignedAt: new Date(),
            active: false,
          },
        });
        if (claim.count === 0) continue;
        username = account.username;
        baseFollower = account.lastFollowerCount ?? 0;
        testAccountId = account.id;
        bulkLink =
          service.platform === "instagram"
            ? `https://www.instagram.com/${username}/`
            : `https://www.tiktok.com/@${username}`;
        claimed = true;
      }
      if (!claimed) return { kind: "no_pool" };
    }

    const toggles = await getSystemToggles();
    const simulated = !toggles.testBotEnabled || toggles.dryRunMode;

    const order = simulated
      ? { order: Date.now() + Math.floor(Math.random() * 1000) }
      : await placeOrder({
          service: service.bulkmedyaId,
          link: bulkLink,
          quantity: testQty,
        });

    if ("error" in order) {
      // Release the pool entity — BulkMedya rejected, keep it
      // available for the next attempt.
      if (postId) {
        await prisma.testPost
          .update({
            where: { id: postId },
            data: { status: "available", assignedAt: null },
          })
          .catch(() => null);
      } else {
        await prisma.testAccount
          .update({
            where: { id: testAccountId },
            data: { status: "available", assignedAt: null, active: true },
          })
          .catch(() => null);
      }
      // Stamp the error on Service so /api/balance/retry-budget
      // can find balance-related rejections + compute the
      // recharge amount needed to retry them.
      const reason = String(order.error).slice(0, 500);
      await prisma.service
        .update({
          where: { id: service.id },
          data: {
            lastPlacementError: reason,
            lastPlacementErrorAt: new Date(),
          },
        })
        .catch(() => null);
      return { kind: "bulkmedya_failed", reason: reason.slice(0, 200) };
    }

    // Write the TestOrder + T+0 baseline measurement inline.
    const testOrder = await prisma.testOrder.create({
      data: {
        serviceId: service.id,
        testAccountId,
        bulkmedyaOrderId: simulated ? `sim-${order.order}` : String(order.order),
        targetQuantity: testQty,
        baselineCount: baseFollower,
        status: "running",
        dryRun: simulated,
        lastHealthCheckAt: new Date(),
        nextPollAt: new Date(Date.now() + 12 * 60 * 60_000),
      },
    });
    await prisma.measurement.create({
      data: {
        testOrderId: testOrder.id,
        checkpoint: "T+0",
        actualCount: baseFollower,
        realismData: {},
      },
    });
    if (postId) {
      await prisma.testPost
        .update({
          where: { id: postId },
          data: { assignedTestOrderId: testOrder.id },
        })
        .catch(() => null);
    } else {
      await prisma.testAccount
        .update({
          where: { id: testAccountId },
          data: { assignedTestOrderId: testOrder.id },
        })
        .catch(() => null);
    }
    // Lifecycle: NEW or PLACEMENT_FAILED → TESTING. Including
    // PLACEMENT_FAILED is critical for the balance-retry path —
    // services that bounced for balance reasons live in
    // PLACEMENT_FAILED, and a successful retry must promote them
    // to TESTING + flip isEligible back on so the routing layer
    // sees them as live again.
    await prisma.productServiceCandidate.updateMany({
      where: {
        serviceId: service.id,
        lifecycleStatus: { in: ["NEW", "PLACEMENT_FAILED"] },
      },
      data: { lifecycleStatus: "TESTING", isEligible: true },
    });
    // Clear any prior balance / placement error stamp now that
    // BulkMedya accepted the order. The BalanceRetryCard hides
    // services without a recent error, so successful retries
    // empty out the card automatically.
    await prisma.service.update({
      where: { id: service.id },
      data: {
        lastTestedAt: new Date(),
        lastPlacementError: null,
        lastPlacementErrorAt: null,
      },
    });
    return { kind: "placed", testOrderId: testOrder.id };
  } catch (e) {
    return { kind: "thrown", reason: (e as Error).message.slice(0, 200) };
  }
}

// ── Tick (called by /api/cron/brute-campaign-runner) ───────────

export async function runBruteCampaignTick(): Promise<BruteTickResult> {
  const result: BruteTickResult = {
    campaignId: null,
    placed: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    done: false,
  };
  const campaign = await prisma.scoringCampaign.findFirst({
    where: { status: "running", stopReason: BRUTE_MARKER },
    orderBy: { id: "desc" },
  });
  if (!campaign) {
    result.done = true;
    return result;
  }
  result.campaignId = campaign.id;

  const placedSet = new Set(campaign.placedServiceIds);
  const pending = campaign.targetServiceIds.filter((id) => !placedSet.has(id));
  if (pending.length === 0) {
    await prisma.scoringCampaign.update({
      where: { id: campaign.id },
      data: { status: "completed", finishedAt: new Date() },
    });
    result.done = true;
    return result;
  }
  const batch = pending.slice(0, BATCH_SIZE_BRUTE);

  // Round-robin RapidAPI keys across waves. The brute placement
  // doesn't make oracle calls but BulkMedya client may indirectly
  // touch the rate limiter; the wrap costs nothing when unused.
  const activeKeys = await prisma.rapidApiKey.findMany({
    where: { provider: "instagram", status: "active" },
    select: { id: true, token: true, provider: true },
  });

  const placed = new Set<number>(placedSet);
  const failed = new Set<number>();

  let flushAccum = 0;
  const flush = async () => {
    if (flushAccum === 0) return;
    flushAccum = 0;
    await prisma.scoringCampaign.update({
      where: { id: campaign.id },
      data: {
        placedServiceIds: Array.from(placed),
        placedCount: result.placed + (campaign.placedCount ?? 0),
        abortedCount: result.failed + (campaign.abortedCount ?? 0),
      },
    });
  };

  const placeOne = async (sid: number, idx: number) => {
    const key = activeKeys.length ? activeKeys[idx % activeKeys.length] : null;
    const run = async () => {
      const outcome = await placeBruteOne(sid);
      if (outcome.kind === "placed") {
        result.placed++;
        placed.add(sid);
      } else if (outcome.kind === "no_pool") {
        // Don't mark placed so the next tick retries when pool
        // refills. Counts as skipped.
        result.skipped++;
      } else {
        // bulkmedya_failed or thrown — distinct state.
        await prisma.productServiceCandidate.updateMany({
          where: { serviceId: sid },
          data: { lifecycleStatus: "PLACEMENT_FAILED", isEligible: false },
        });
        // Stamp the actual reason so the BalanceRetryCard can
        // distinguish balance-bounced vs other-reason fails.
        // bulkmedya_failed has its own stamp inside placeBruteOne;
        // we cover thrown outcomes here so 'service_not_found',
        // 'max_below_floor', or runtime exceptions are visible.
        const reason = (outcome as { reason?: string }).reason ?? outcome.kind;
        if (outcome.kind !== "bulkmedya_failed") {
          await prisma.service
            .update({
              where: { id: sid },
              data: {
                lastPlacementError: `${outcome.kind}: ${reason}`.slice(0, 500),
                lastPlacementErrorAt: new Date(),
              },
            })
            .catch(() => null);
        }
        result.failed++;
        failed.add(sid);
        placed.add(sid); // mark to skip on next tick
        console.warn(`[brute] svc#${sid} ${outcome.kind}: ${reason}`);
      }
      flushAccum++;
    };
    if (key) {
      await withApiKey(
        { id: key.id, token: key.token, provider: key.provider },
        undefined,
        run
      );
    } else {
      await run();
    }
  };

  for (let i = 0; i < batch.length; i += CONCURRENCY_BRUTE) {
    // Cooperative stop check between waves. The /api/scoring/campaign
    // STOP endpoint flips campaign.status='paused' or 'stopped'; we
    // exit the loop cleanly so the operator's STOP click materialises
    // within ~1 wave (~5 s) instead of dragging through the full
    // BATCH_SIZE_BRUTE.
    const fresh = await prisma.scoringCampaign.findUnique({
      where: { id: campaign.id },
      select: { status: true },
    });
    if (!fresh || fresh.status !== "running") {
      console.log(
        `[brute] stop signal received (status=${fresh?.status ?? "deleted"}) — exiting batch loop`
      );
      break;
    }
    const wave = batch.slice(i, i + CONCURRENCY_BRUTE);
    await Promise.all(wave.map((sid, j) => placeOne(sid, i + j)));
    if (FLUSH_EVERY_WAVE) await flush();
  }
  await flush();
  // RapidAPI usage counters need a manual drain too — withApiKey
  // doesn't auto-flush like withAssignedKey does. Without this,
  // the last batch of recordApiCall increments is lost when the
  // Vercel lambda terminates.
  await flushUsage();

  result.remaining = campaign.targetServiceIds.length - placed.size;
  if (result.remaining <= 0) {
    await prisma.scoringCampaign.update({
      where: { id: campaign.id },
      data: { status: "completed", finishedAt: new Date() },
    });
    result.done = true;
  }
  return result;
}

// Helper: dashboard / endpoint convenience — returns the active
// brute campaign with a few derived fields.
export async function getActiveBruteCampaign() {
  const c = await prisma.scoringCampaign.findFirst({
    where: { status: { in: ["running", "paused"] }, stopReason: BRUTE_MARKER },
    orderBy: { id: "desc" },
  });
  if (!c) return null;
  const remaining =
    c.targetServiceIds.length - c.placedServiceIds.length;
  const elapsedMin = Math.max(
    1,
    Math.floor((Date.now() - c.startedAt.getTime()) / 60_000)
  );
  const ratePerHour = (c.placedCount / elapsedMin) * 60;
  const etaMinutes =
    ratePerHour > 0 ? Math.round((remaining / ratePerHour) * 60) : null;
  return {
    id: c.id,
    status: c.status,
    startedAt: c.startedAt.toISOString(),
    finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    targetCount: c.targetServiceIds.length,
    placedCount: c.placedCount,
    failedCount: c.abortedCount,
    remaining,
    estimatedCostUsd: c.estimatedCostUsd,
    placementRatePerHour: Math.round(ratePerHour),
    etaMinutes,
  };
}
