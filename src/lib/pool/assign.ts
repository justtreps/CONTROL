// Atomic pick-and-assign + consume helpers for the test account / post pool.
//
// Follower pool: one account = one test for its entire lifetime.
// Engagement pool: one POST = one test (a single parent account can
// contribute N posts). Both flows must guarantee that two concurrent
// callers can never claim the same row.
//
// Concurrency model — compare-and-swap, not transaction isolation:
// PostgreSQL default isolation is read-committed, which means two
// concurrent transactions BOTH see the row at status='available'
// before either commits. A naive findFirst-then-update inside a
// $transaction therefore lets both callers update the same row, and
// both think they own the account. We instead issue updateMany with
// a compound `{ id, status: 'available' }` where-clause: the second
// caller's updateMany matches zero rows (status is already
// 'assigned' from the first caller's commit), `count === 0`, and we
// re-roll. Bounded loop so a hot-pool can't spin forever.
//
// Country filter is layered on top: try the exact-country pool
// first, fall back to country-less. Confidence floor defaults to
// 'medium'.

import { prisma } from "@/lib/prisma";
import type { TestAccount, TestPost } from "@prisma/client";

const MAX_PICK_ATTEMPTS = 8;

export async function pickAndAssignAccount({
  platform,
  testOrderId,
  accountType,
  targetCountry,
  minCountryConfidence,
}: {
  platform: string;
  testOrderId: number;
  // When omitted, we pick ANY accountType (backward-compat: the old
  // testbot call sites didn't pass this and got whatever was next in
  // the FIFO queue — which in practice was always follower_test since
  // engagement_test accounts didn't exist yet).
  accountType?: "follower_test" | "engagement_test";
  // Optional ISO-2 country — when set, we first try to pick an
  // account whose detectedCountry matches AND whose confidence is
  // at least minCountryConfidence (default 'medium'). If none, we
  // fall back to a country-less pick so the test still runs (just
  // without a geo match).
  targetCountry?: string | null;
  minCountryConfidence?: "high" | "medium" | "low" | "unknown";
}): Promise<TestAccount | null> {
  const minConf = minCountryConfidence ?? "medium";
  const confOrder = ["unknown", "low", "medium", "high"];
  const minConfIdx = confOrder.indexOf(minConf);
  const acceptableConfs = confOrder.slice(minConfIdx);

  const baseWhere = {
    platform,
    status: "available",
    ...(accountType ? { accountType } : {}),
  };

  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    // 1st try: exact country match with acceptable confidence.
    let candidate: TestAccount | null = null;
    if (targetCountry) {
      candidate = await prisma.testAccount.findFirst({
        where: {
          ...baseWhere,
          detectedCountry: targetCountry,
          countryConfidence: { in: acceptableConfs },
        },
        orderBy: { firstSeenAt: "asc" },
      });
    }
    if (!candidate) {
      candidate = await prisma.testAccount.findFirst({
        where: baseWhere,
        orderBy: { firstSeenAt: "asc" },
      });
    }
    if (!candidate) return null;

    // Compare-and-swap: update only fires if the row is STILL
    // 'available'. count===0 means another caller raced us;
    // pick a different candidate.
    const claim = await prisma.testAccount.updateMany({
      where: { id: candidate.id, status: "available" },
      data: {
        status: "assigned",
        assignedAt: new Date(),
        assignedTestOrderId: testOrderId,
        active: false,
      },
    });
    if (claim.count === 1) {
      return prisma.testAccount.findUnique({ where: { id: candidate.id } });
    }
    // Lost the race — loop to pick another candidate.
  }
  return null;
}

// Engagement pool pick-and-assign. Atomically flips ONE TestPost
// available → assigned and returns both the post (carries mediaUrl)
// and its parent TestAccount (needed by the testbot for oracle
// calls, username drift check, etc.). The parent's own status is
// untouched — a single account can have multiple assigned/consumed
// posts over time.
export async function pickAndAssignPost({
  platform,
  testOrderId,
  targetCountry,
  minCountryConfidence,
}: {
  platform: string;
  testOrderId: number;
  targetCountry?: string | null;
  minCountryConfidence?: "high" | "medium" | "low" | "unknown";
}): Promise<{ post: TestPost; account: TestAccount } | null> {
  const minConf = minCountryConfidence ?? "medium";
  const confOrder = ["unknown", "low", "medium", "high"];
  const minConfIdx = confOrder.indexOf(minConf);
  const acceptableConfs = confOrder.slice(minConfIdx);

  // Same compare-and-swap loop as pickAndAssignAccount. See the
  // module-level comment for why $transaction-with-findFirst-then-
  // update is unsafe under read-committed isolation.
  const baseWhere = {
    platform,
    status: "available",
  };
  for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
    let candidate: (TestPost & { testAccount: TestAccount }) | null = null;
    if (targetCountry) {
      candidate = await prisma.testPost.findFirst({
        where: {
          ...baseWhere,
          testAccount: {
            detectedCountry: targetCountry,
            countryConfidence: { in: acceptableConfs },
          },
        },
        include: { testAccount: true },
        orderBy: { firstSeenAt: "asc" },
      });
    }
    if (!candidate) {
      candidate = await prisma.testPost.findFirst({
        where: baseWhere,
        include: { testAccount: true },
        orderBy: { firstSeenAt: "asc" },
      });
    }
    if (!candidate) return null;

    const claim = await prisma.testPost.updateMany({
      where: { id: candidate.id, status: "available" },
      data: {
        status: "assigned",
        assignedAt: new Date(),
        assignedTestOrderId: testOrderId,
        active: false,
      },
    });
    if (claim.count === 1) {
      const updated = await prisma.testPost.findUnique({
        where: { id: candidate.id },
      });
      if (!updated) return null;
      return { post: updated, account: candidate.testAccount };
    }
  }
  return null;
}

export async function consumeAccount(testAccountId: number): Promise<void> {
  await prisma.testAccount.update({
    where: { id: testAccountId },
    data: {
      status: "consumed",
      consumedAt: new Date(),
    },
  });
}

export async function invalidateAccount(
  testAccountId: number,
  reason: string
): Promise<void> {
  // Cascade: any post that was still 'available' or 'assigned' on a
  // now-invalid parent account can never be a valid engagement test
  // again (the account is banned / private / deleted). Flip them to
  // invalid(parent_invalid) so the engagement pool doesn't re-serve
  // ghost posts.
  await prisma.$transaction([
    prisma.testAccount.update({
      where: { id: testAccountId },
      data: {
        status: "invalid",
        invalidReason: reason,
        invalidatedAt: new Date(),
        active: false,
      },
    }),
    prisma.testPost.updateMany({
      where: {
        testAccountId,
        status: { in: ["available", "assigned"] },
      },
      data: {
        status: "invalid",
        invalidReason: "parent_invalid",
        invalidatedAt: new Date(),
        active: false,
      },
    }),
  ]);
}

export async function consumePost(testPostId: number): Promise<void> {
  await prisma.testPost.update({
    where: { id: testPostId },
    data: { status: "consumed", consumedAt: new Date() },
  });
}

export async function invalidatePost(
  testPostId: number,
  reason: string
): Promise<void> {
  await prisma.testPost.update({
    where: { id: testPostId },
    data: {
      status: "invalid",
      invalidReason: reason,
      invalidatedAt: new Date(),
      active: false,
    },
  });
}

// Put a post back in the pool after a transient placement failure
// (oracle error, BulkMedya rejection, etc.) so another run can retry.
export async function releasePost(testPostId: number): Promise<void> {
  await prisma.testPost.update({
    where: { id: testPostId },
    data: {
      status: "available",
      assignedAt: null,
      assignedTestOrderId: null,
      active: true,
    },
  });
}

// Flip assigned accounts to 'consumed' once the test has progressed.
// Two signals count as "test is done":
//   1. TestOrder has ≥1 measurement past T+0 (actual data collected)
//   2. assignedAt older than 48h (safety net — measurement bot may
//      have failed, but the account is stuck; we don't want it to
//      stay assigned forever)
//
// Idempotent — accounts already consumed are filtered out by the
// initial `status='assigned'` query. Called from the scoring cron
// (every 10 min) and from the weekly cleanup cron as a backup.
export async function consumeCompletedAssignments(): Promise<{
  byMeasurement: number;
  byTimeout: number;
  postsByMeasurement: number;
  postsByTimeout: number;
}> {
  const stuckDeadline = new Date(Date.now() - 48 * 3600 * 1000);

  // ── Follower pool: assigned TestAccount rows ──
  const assigned = await prisma.testAccount.findMany({
    where: {
      status: "assigned",
      assignedTestOrderId: { not: null },
    },
    select: {
      id: true,
      assignedTestOrderId: true,
      assignedAt: true,
    },
  });

  let byMeasurement = 0;
  let byTimeout = 0;

  for (const a of assigned) {
    // Primary signal: the test has real data beyond the baseline.
    const postBaselineCount = await prisma.measurement.count({
      where: {
        testOrderId: a.assignedTestOrderId!,
        checkpoint: { not: "T+0" },
      },
    });
    if (postBaselineCount > 0) {
      await consumeAccount(a.id);
      byMeasurement++;
      continue;
    }
    // Fallback: stuck for 48h+ with nothing but the placement baseline.
    if (a.assignedAt && a.assignedAt < stuckDeadline) {
      await consumeAccount(a.id);
      byTimeout++;
    }
  }

  // ── Engagement pool: assigned TestPost rows (same semantics) ──
  const assignedPosts = await prisma.testPost.findMany({
    where: {
      status: "assigned",
      assignedTestOrderId: { not: null },
    },
    select: {
      id: true,
      assignedTestOrderId: true,
      assignedAt: true,
    },
  });

  let postsByMeasurement = 0;
  let postsByTimeout = 0;

  for (const p of assignedPosts) {
    const postBaselineCount = await prisma.measurement.count({
      where: {
        testOrderId: p.assignedTestOrderId!,
        checkpoint: { not: "T+0" },
      },
    });
    if (postBaselineCount > 0) {
      await consumePost(p.id);
      postsByMeasurement++;
      continue;
    }
    if (p.assignedAt && p.assignedAt < stuckDeadline) {
      await consumePost(p.id);
      postsByTimeout++;
    }
  }

  return { byMeasurement, byTimeout, postsByMeasurement, postsByTimeout };
}
