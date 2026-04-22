import { prisma } from "@/lib/prisma";
import { placeOrder } from "@/lib/bulkmedya";
import { fetchFollowerSnapshot, type Platform } from "@/lib/rapidapi";
import { pickAndAssignAccount, invalidateAccount } from "@/lib/pool/assign";
import { fetchOracleFor } from "@/lib/pool/oracle";
import { getSystemToggles } from "@/lib/system/toggles";
import type { Service, TestAccount } from "@prisma/client";

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
type AttemptOutcome =
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

  // Kill-switch: when test-bot is disabled we force a simulated path
  // — no real BulkMedya calls fire, TestOrder rows are written with a
  // simulated_<ts> id so the rest of the pipeline (scoring, health
  // check) keeps working without contaminating the pool.
  const toggles = await getSystemToggles();
  const simulated = !toggles.testBotEnabled;

  const cutoff = new Date(Date.now() - SERVICE_COOLDOWN_HOURS * 3600 * 1000);

  const services = await prisma.service.findMany({
    where: {
      active: true,
      platform: { in: ["instagram", "tiktok"] },
    },
    include: {
      testOrders: { orderBy: { placedAt: "desc" }, take: 1 },
    },
  });

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
async function attemptPlaceOrder({
  service,
  simulated,
}: {
  service: Service;
  simulated: boolean;
}): Promise<AttemptOutcome> {
  let assignedAccountId: number | null = null;
  let poolPick: TestAccount | null = null;

  try {
    // ─── Resolve account ────────────────────────────────────────────
    let account: TestAccount | null = null;

    poolPick = await pickAndAssignAccount({
      platform: service.platform,
      testOrderId: -1, // backfilled after TestOrder creation
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

    // ─── Baseline-at-placement ──────────────────────────────────────
    // Re-read the account via the oracle by stable user_id. Gives us:
    //  1. The CURRENT username (survives renames)
    //  2. A fresh follower_count used as the TestOrder baseline
    //  3. A chance to abort cleanly if the account is now a ghost /
    //     became private / drifted past invalidate thresholds
    const oracle = await fetchOracleFor(service.platform, account.userId);

    if (!oracle.ok) {
      if (oracle.reason === "ghost" && poolPick) {
        await invalidateAccount(poolPick.id, "deleted");
      } else if (poolPick) {
        // Transient oracle error — release the account so another
        // run / another service can retry it later.
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
      return {
        kind: "skip",
        reason:
          oracle.reason === "ghost"
            ? `account_ghost_${account.userId}`
            : `oracle_error: ${oracle.message.slice(0, 80)}`,
      };
    }

    // ─── NEW: isPrivate guard ───────────────────────────────────────
    // Between scrape time and now, the account may have flipped
    // private. BulkMedya can't deliver followers to a private IG
    // account so placing an order would waste budget + generate a
    // refund. Invalidate the row (it can never be a valid test
    // account again while private) and tell the caller to retry the
    // service with a different account.
    if (service.platform === "instagram" && oracle.isPrivate) {
      if (poolPick) {
        await prisma.testAccount.update({
          where: { id: poolPick.id },
          data: {
            status: "invalid",
            invalidReason: "became_private",
            invalidatedAt: new Date(),
            active: false,
            assignedAt: null,
            assignedTestOrderId: null,
            lastFollowerCount: oracle.followerCount,
            lastMediaCount: oracle.mediaCount,
            lastFollowingCount: oracle.followingCount,
          },
        });
      } else {
        // Legacy account: flip invalid too.
        await prisma.testAccount.update({
          where: { id: account.id },
          data: {
            status: "invalid",
            invalidReason: "became_private",
            invalidatedAt: new Date(),
            active: false,
          },
        });
      }
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

    const order = simulated
      ? { order: Date.now() }
      : await placeOrder({
          service: service.bulkmedyaId,
          link: targetUrlFor(service.platform, currentUsername),
          quantity: service.minQuantity,
        });

    if ("error" in order) {
      // BulkMedya rejected the order — release the pool account so
      // it's not burned on an upstream error.
      if (poolPick) {
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
      return { kind: "skip", reason: `bulkmedya: ${order.error}` };
    }

    const testOrder = await prisma.testOrder.create({
      data: {
        serviceId: service.id,
        testAccountId: account.id,
        bulkmedyaOrderId: simulated ? `sim-${order.order}` : String(order.order),
        targetQuantity: service.minQuantity,
        baselineCount: baseline.count,
      },
    });

    if (poolPick) {
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

    if (!poolPick) {
      await prisma.testAccount.update({
        where: { id: account.id },
        data: { lastTestedAt: new Date() },
      });
    }

    return { kind: "placed" };
  } catch (e) {
    // Unexpected error — rollback any pool assignment so the account
    // isn't stuck. Skip this service; don't retry on unknown errors.
    if (assignedAccountId) {
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
