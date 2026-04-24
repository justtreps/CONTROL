import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";
import { fetchFollowerSnapshot, type Platform } from "@/lib/rapidapi";
import {
  pickAndAssignAccount,
  pickAndAssignPost,
  invalidateAccount,
  releasePost,
} from "@/lib/pool/assign";
import { fetchOracleFor } from "@/lib/pool/oracle";
import { getSystemToggles } from "@/lib/system/toggles";
import { TESTABLE_WHERE, SELLABLE_PLATFORMS } from "@/lib/services/testable";
import { markTesting } from "@/lib/catalogue/lifecycle";
import type { Service, TestAccount, TestPost } from "@prisma/client";

const ACCOUNT_COOLDOWN_HOURS = 48;
const SERVICE_COOLDOWN_HOURS = 24;
// When the pre-placement oracle reports a pool-assigned account as
// now-private (IG only), we invalidate it and retry with another
// account for the same service. Cap at 5 attempts so a pathological
// pool slice can't pin the test-bot on one service.
const MAX_PRIVATE_RETRIES = 5;

function targetUrlFor(platform: string, username: string): string {
  if (platform === "instagram") return `https://www.instagram.com/${username}/`;
  if (platform === "tiktok") return `https://www.tiktok.com/@${username}`;
  throw new Error(`Unknown platform: ${platform}`);
}

// Legacy fallback: pre-pool manual accounts (scrapeSource IS NULL OR 'manual').
// Used only when the auto pool is empty for the platform.
async function pickLegacyAccountForService(
  service: Service
): Promise<TestAccount | null> {
  const cutoff = new Date(Date.now() - ACCOUNT_COOLDOWN_HOURS * 3600 * 1000);

  const recent = await prisma.testOrder.findMany({
    where: { serviceId: service.id, placedAt: { gte: cutoff } },
    select: { testAccountId: true },
  });
  const excludeIds = recent.map((r) => r.testAccountId);

  return prisma.testAccount.findFirst({
    where: {
      platform: service.platform,
      active: true,
      status: { in: ["available"] },
      OR: [{ scrapeSource: null }, { scrapeSource: "manual" }],
      ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
    },
    orderBy: [{ lastTestedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  });
}

export type TestBotResult = {
  attempted: number;
  placed: number;
  skipped: number;
  privateRetries: number;
  errors: Array<{ serviceId: number; serviceName: string; reason: string }>;
};

// Outcome of a single per-service attempt. The outer loop uses this
// to decide whether to retry with another account, bail on the
// service, or count a success.
export type AttemptOutcome =
  | { kind: "placed" }
  | { kind: "retry_private"; reason: string }
  | { kind: "skip"; reason: string }
  | { kind: "no_account"; reason: string };

export async function runTestBot(
  opts: { maxOrders?: number } = {}
): Promise<TestBotResult> {
  // Bumped 10 → 30 because we saw TT services get completely starved:
  // with 1096 IG vs 714 TT active services and a "never-tested first"
  // sort, all 10 slots went to IG every run and TT tests never fired.
  // At 30 slots with fair platform rotation below, each platform gets
  // ~15 per run and the full catalog cycles through in ~2.5 days
  // instead of 7.5.
  const maxOrders = opts.maxOrders ?? 30;
  const result: TestBotResult = {
    attempted: 0,
    placed: 0,
    skipped: 0,
    privateRetries: 0,
    errors: [],
  };

  // Simulated-placement gate. Two independent toggles push us into
  // fake-BulkMedya mode:
  //   • testBotEnabled=false — master kill switch
  //   • dryRunMode=true       — production safety gate (default)
  // Either one being truthy forces sim-* bulkmedyaOrderId and no
  // real BulkMedya call. Measurements still come from real RapidAPI
  // reads so the scoring pipeline keeps running on real signal.
  const toggles = await getSystemToggles();
  const simulated = !toggles.testBotEnabled || toggles.dryRunMode;

  const cutoff = new Date(Date.now() - SERVICE_COOLDOWN_HOURS * 3600 * 1000);

  // Catalogue-only gate: the testbot is the upstream feeder for
  // ServiceScore + ProductServiceCandidate.currentScore, so it only
  // tests services that are eligible candidates for at least one
  // MyBoost product. Services that never match anything in the
  // catalogue (e.g. "Instagram Comments" rows) stay dormant.
  // Predicate here matches the matcher's output: isEligible=true AND
  // !forceExcluded for at least one active product.
  const eligibleServiceIdsRows = await prisma.productServiceCandidate.findMany(
    {
      where: {
        isEligible: true,
        forceExcluded: false,
        product: { isActive: true },
      },
      select: { serviceId: true },
      distinct: ["serviceId"],
    }
  );
  const eligibleIds = eligibleServiceIdsRows.map((r) => r.serviceId);

  const [services, totalActiveOnSellablePlatforms] = await Promise.all([
    eligibleIds.length === 0
      ? Promise.resolve([] as Array<
          import("@prisma/client").Service & {
            testOrders: import("@prisma/client").TestOrder[];
          }
        >)
      : prisma.service.findMany({
          where: {
            id: { in: eligibleIds },
            // Still require the legacy sellable-bucket fields so a
            // stale Service row we've since flipped to manual review
            // never sneaks back in through the catalogue. Belt +
            // braces while the two sources of truth co-exist.
            ...TESTABLE_WHERE,
          },
          include: {
            testOrders: { orderBy: { placedAt: "desc" }, take: 1 },
          },
        }),
    prisma.service.count({
      where: {
        active: true,
        platform: { in: [...SELLABLE_PLATFORMS] },
      },
    }),
  ]);

  const skippedNotSellable = Math.max(
    0,
    totalActiveOnSellablePlatforms - services.length
  );
  console.log(
    `[testbot] Filtered ${services.length} catalogue-eligible services (total candidates: ${eligibleIds.length}), skipped ${skippedNotSellable}`
  );

  // Platform-fair rotation: split eligible services per platform,
  // take the oldest half of maxOrders from each, then interleave so
  // the run alternates IG / TT / IG / TT. Prevents the starvation we
  // saw where 1000+ never-tested IG services always sorted ahead of
  // any TT service and TT never got a slot.
  const eligible = services.filter((s) => {
    const last = s.testOrders[0];
    return !last || last.placedAt < cutoff;
  });
  const byLastTest = (
    a: (typeof services)[number],
    b: (typeof services)[number]
  ) => {
    const la = a.testOrders[0]?.placedAt?.getTime() ?? 0;
    const lb = b.testOrders[0]?.placedAt?.getTime() ?? 0;
    return la - lb;
  };
  const igHalf = Math.ceil(maxOrders / 2);
  const ttHalf = Math.floor(maxOrders / 2);
  const dueIg = eligible
    .filter((s) => s.platform === "instagram")
    .sort(byLastTest)
    .slice(0, igHalf);
  const dueTt = eligible
    .filter((s) => s.platform === "tiktok")
    .sort(byLastTest)
    .slice(0, ttHalf);
  const due: typeof services = [];
  const maxLen = Math.max(dueIg.length, dueTt.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < dueIg.length) due.push(dueIg[i]);
    if (i < dueTt.length) due.push(dueTt[i]);
  }

  for (const service of due) {
    result.attempted++;
    let placed = false;

    for (
      let attempt = 1;
      attempt <= MAX_PRIVATE_RETRIES && !placed;
      attempt++
    ) {
      const outcome = await attemptPlaceOrder({ service, simulated });

      if (outcome.kind === "placed") {
        result.placed++;
        placed = true;
        break;
      }

      if (outcome.kind === "retry_private") {
        result.privateRetries++;
        result.errors.push({
          serviceId: service.id,
          serviceName: service.name,
          reason: `retry_private_attempt_${attempt}: ${outcome.reason}`,
        });
        continue; // loop to next attempt, fresh account
      }

      // no_account OR skip — non-retryable, escalate to next service
      if (outcome.kind === "no_account") result.skipped++;
      result.errors.push({
        serviceId: service.id,
        serviceName: service.name,
        reason: outcome.reason,
      });
      break;
    }

    if (!placed && result.errors.length > 0) {
      // If we exhausted all retry attempts on private accounts without
      // placing, log a summary error so the UI surfaces why.
      const lastPushed = result.errors[result.errors.length - 1];
      if (lastPushed.reason.startsWith("retry_private_attempt_")) {
        result.errors.push({
          serviceId: service.id,
          serviceName: service.name,
          reason: `max_private_retries_reached_${MAX_PRIVATE_RETRIES}`,
        });
      }
    }
  }

  return result;
}

// Single attempt at placing a test order for `service`. Returns an
// AttemptOutcome that the caller uses to decide whether to retry
// (private-account case) or escalate.
//
// Two routing modes:
//   • Follower services → pick + assign a TestAccount (profile URL)
//   • Engagement services → pick + assign a TestPost (post URL) and
//     keep a parallel reference to its parent TestAccount for the
//     oracle re-check + TestOrder.testAccountId lineage.
export async function attemptPlaceOrder({
  service,
  simulated,
}: {
  service: Service;
  simulated: boolean;
}): Promise<AttemptOutcome> {
  let assignedAccountId: number | null = null;
  let assignedPostId: number | null = null;
  let poolPick: TestAccount | null = null;
  let postPick: TestPost | null = null;

  try {
    const serviceRouting = service as Service & {
      poolType?: string;
      targetCountry?: string | null;
    };
    const isEngagement = serviceRouting.poolType === "engagement_test";

    // ─── Resolve account (follower) OR post (engagement) ────────────
    let account: TestAccount | null = null;
    let postUrlOverride: string | null = null;

    if (isEngagement) {
      const pick = await pickAndAssignPost({
        platform: service.platform,
        testOrderId: -1,
        targetCountry: serviceRouting.targetCountry ?? null,
      });
      if (!pick) {
        return { kind: "no_account", reason: "no_available_post" };
      }
      postPick = pick.post;
      assignedPostId = pick.post.id;
      account = pick.account;
      postUrlOverride = pick.post.mediaUrl;
    } else {
      // Follower or unclassified service: pick an account from the
      // follower pool (accountType='follower_test' forces the filter
      // away from engagement parent rows that are purely metadata).
      const routingType: "follower_test" | undefined =
        serviceRouting.poolType === "follower_test" ? "follower_test" : "follower_test";

      poolPick = await pickAndAssignAccount({
        platform: service.platform,
        testOrderId: -1,
        accountType: routingType,
        targetCountry: serviceRouting.targetCountry ?? null,
      });
      if (poolPick) {
        account = poolPick;
        assignedAccountId = poolPick.id;
      } else {
        account = await pickLegacyAccountForService(service);
      }
      if (!account) {
        return { kind: "no_account", reason: "no_available_account" };
      }
    }

    // Helper — release the held pool entity back to 'available' on
    // transient failures (oracle error, BulkMedya rejection).
    const releaseHeld = async (): Promise<void> => {
      if (postPick) {
        await releasePost(postPick.id);
      } else if (poolPick) {
        await prisma.testAccount.update({
          where: { id: poolPick.id },
          data: {
            status: "available",
            assignedAt: null,
            assignedTestOrderId: null,
            active: true,
          },
        });
      }
    };

    // ─── Baseline-at-placement ──────────────────────────────────────
    // Re-read the parent account via the oracle by stable user_id.
    // Gives us:
    //  1. The CURRENT username (survives renames)
    //  2. A fresh follower_count used as the TestOrder baseline
    //  3. A chance to abort cleanly if the account is now a ghost /
    //     became private / drifted past invalidate thresholds
    const oracle = await fetchOracleFor(service.platform, account.userId);

    if (!oracle.ok) {
      if (oracle.reason === "ghost") {
        // Parent deleted — invalidateAccount cascades the account's
        // remaining posts to invalid(parent_invalid) so we don't
        // re-serve them. Works for both follower and engagement paths.
        await invalidateAccount(account.id, "deleted");
        // Retry with a fresh pool entity — same loop as the private
        // flip below. Turns a dead pick into a transparent retry
        // instead of a cold skip.
        return {
          kind: "retry_private",
          reason: `account_ghost_${account.userId}`,
        };
      }
      await releaseHeld();
      return {
        kind: "skip",
        reason: `oracle_error: ${oracle.message.slice(0, 80)}`,
      };
    }

    // ─── isPrivate guard ────────────────────────────────────────────
    // IG private flip: invalidate the parent account (cascades any
    // remaining posts to invalid) and tell the caller to retry the
    // service with a different pool entity.
    if (service.platform === "instagram" && oracle.isPrivate) {
      await invalidateAccount(account.id, "became_private");
      await prisma.testAccount.update({
        where: { id: account.id },
        data: {
          lastFollowerCount: oracle.followerCount,
          lastMediaCount: oracle.mediaCount,
          lastFollowingCount: oracle.followingCount,
        },
      });
      return {
        kind: "retry_private",
        reason: `@${account.username} flipped private`,
      };
    }

    // Use the oracle's CURRENT username. Sync the DB if it drifted.
    const currentUsername = oracle.username || account.username;
    if (currentUsername !== account.username) {
      await prisma.testAccount.update({
        where: { id: account.id },
        data: { username: currentUsername },
      });
      account = { ...account, username: currentUsername };
    }

    // Realism sample still comes from fetchFollowerSnapshot (it does
    // a /followers call and scores the sample). Baseline count comes
    // from the oracle — it's the authoritative number at placement time.
    const sample = await fetchFollowerSnapshot(
      service.platform as Platform,
      currentUsername,
      oracle.userId
    );
    const baseline = {
      count: oracle.followerCount,
      realismScore: sample.realismScore,
      realismData: sample.realismData,
    };

    // Route BulkMedya at the right URL: specific post URL for
    // engagement tests, profile URL for follower tests.
    const bulkmedyaLink =
      postUrlOverride ?? targetUrlFor(service.platform, currentUsername);
    const order = simulated
      ? { order: Date.now() }
      : await placeOrder({
          service: service.bulkmedyaId,
          link: bulkmedyaLink,
          quantity: service.minQuantity,
        });

    if ("error" in order) {
      await releaseHeld();
      // Emit service.died — any workflow listening on the event bus
      // can react (dispatcher would be a forceExcluded toggle on
      // the ProductServiceCandidate, a notify, etc.). Best-effort;
      // the skip path above already handles the local failure.
      const { emit } = await import("@/lib/workflows/events");
      await emit("service.died", {
        serviceId: service.id,
        bulkmedyaId: service.bulkmedyaId,
        reason: String(order.error).slice(0, 200),
      });
      return { kind: "skip", reason: `bulkmedya: ${order.error}` };
    }

    const testOrder = await prisma.testOrder.create({
      data: {
        serviceId: service.id,
        testAccountId: account.id,
        bulkmedyaOrderId: simulated ? `sim-${order.order}` : String(order.order),
        targetQuantity: service.minQuantity,
        baselineCount: baseline.count,
        status: "running",
        // Record the mode this order was placed in. /logs + scoring
        // filters use this to separate production tests from dry-run
        // simulations.
        dryRun: simulated,
        // Pre-test health check just succeeded (oracle was ok above).
        lastHealthCheckAt: new Date(),
        // Fixed 12h polling cadence — first poll fires 12h after
        // placement. SMM delivery is paced in hours/days; earlier
        // polls would burn RapidAPI for zero signal. See
        // lib/testbot/poller.ts for the full flow.
        nextPollAt: new Date(Date.now() + 12 * 60 * 60_000),
      },
    });

    // Lifecycle transition: NEW → TESTING. No-op if the candidacy
    // has already advanced past NEW (retest / re-qualification).
    await markTesting(service.id);

    // Stamp the service's lastTestedAt so the /config/services-review
    // obsolescence filter has a fresh signal. Denormalised max of
    // TestOrder.placedAt; far cheaper than a JOIN + GROUP BY on the
    // review page every render.
    await prisma.service.update({
      where: { id: service.id },
      data: { lastTestedAt: new Date() },
    });

    if (postPick) {
      await prisma.testPost.update({
        where: { id: postPick.id },
        data: { assignedTestOrderId: testOrder.id },
      });
    } else if (poolPick) {
      await prisma.testAccount.update({
        where: { id: poolPick.id },
        data: { assignedTestOrderId: testOrder.id },
      });
    }

    await prisma.measurement.create({
      data: {
        testOrderId: testOrder.id,
        checkpoint: "T+0",
        actualCount: baseline.count,
        realismData: baseline.realismData,
        realismScore: baseline.realismScore,
      },
    });

    if (!poolPick && !postPick) {
      await prisma.testAccount.update({
        where: { id: account.id },
        data: { lastTestedAt: new Date() },
      });
    }

    return { kind: "placed" };
  } catch (e) {
    // Unexpected error — rollback any assignment so the pool entity
    // isn't stuck. Skip this service; don't retry on unknown errors.
    if (assignedPostId) {
      await releasePost(assignedPostId).catch(() => null);
    } else if (assignedAccountId) {
      await prisma.testAccount
        .update({
          where: { id: assignedAccountId },
          data: {
            status: "available",
            assignedAt: null,
            assignedTestOrderId: null,
            active: true,
          },
        })
        .catch(() => null);
    }
    return { kind: "skip", reason: (e as Error).message };
  }
}
