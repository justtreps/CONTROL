// Mass pool cleanup coordinator — state machine that runs while a
// ScoringCampaign is paused with status="paused_for_pool_cleanup".
//
// Why this exists:
//   The mass scoring campaign burns ~90% of attempts as aborts when
//   the pool has stale (private/ghost) accounts. A 20-min cleanup
//   pass before the campaign fixes the abort rate and makes the
//   campaign meaningful. This coordinator glues three existing
//   subsystems together without duplicating code:
//     1. /api/cron/pool-health-check      — oracle+invalidate pass
//     2. /api/pool/backfill-country       — re-detect country (no API)
//     3. prisma.scoringCampaign           — resume or keep paused
//
// State is stored in the Config key "pool_cleanup:session". Phases:
//   "trigger"  — pause just set, coordinator will fire the first
//                health-check run.
//   "wait"     — health-check running (or queued); coordinator polls
//                PoolJob for terminal status.
//   "finalize" — cleanup finished, run country reclassify + decide
//                whether to resume or alert on insufficient pool.
// When finalize completes the Config row is deleted and the next
// coordinator tick no-ops.
//
// The coordinator itself is a cron endpoint (every 2 min) so a
// stuck state self-recovers on the next tick.

import { prisma } from "@/lib/prisma";
import { detectAccountCountry } from "@/lib/pool/country-detection";

const CONFIG_KEY = "pool_cleanup:session";

// When the pool has fewer active accounts than this after cleanup,
// we keep the campaign paused and emit pool_insufficient alert so
// the operator can kick off a scrape.
const MIN_POOL_FOR_RESUME = 500;

export type CleanupPhase = "trigger" | "wait" | "finalize";

export type CleanupSession = {
  campaignId: number;
  pausedAt: string; // ISO
  phase: CleanupPhase;
  healthCheckJobId?: number;
  // Post-finalize summary. Kept around briefly for the dashboard
  // but the row is deleted on the next tick.
  lastResult?: {
    at: string;
    poolCountBefore: number;
    poolCountAfter: number;
    invalidated: number;
    countryBackfilled: number;
    action: "resumed" | "stayed_paused";
  };
};

export async function readSession(): Promise<CleanupSession | null> {
  const row = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  if (!row) return null;
  return row.value as unknown as CleanupSession;
}

async function writeSession(s: CleanupSession): Promise<void> {
  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    create: { key: CONFIG_KEY, value: s as unknown as object },
    update: { value: s as unknown as object },
  });
}

async function clearSession(): Promise<void> {
  await prisma.config.deleteMany({ where: { key: CONFIG_KEY } });
}

// Called by /api/pool/mass-cleanup/start — pauses the campaign and
// seeds the Config row. The coordinator cron takes over from here.
export async function beginCleanup(campaignId: number): Promise<CleanupSession> {
  await prisma.scoringCampaign.update({
    where: { id: campaignId },
    data: {
      status: "paused_for_pool_cleanup",
      stopReason: "mass_pool_cleanup_in_progress",
    },
  });
  const session: CleanupSession = {
    campaignId,
    pausedAt: new Date().toISOString(),
    phase: "trigger",
  };
  await writeSession(session);
  return session;
}

// Fire-and-forget the existing health-check endpoint so a fresh
// Vercel invocation handles the 280s oracle pass. We don't await
// the response — the PoolJob it creates is the source of truth.
async function triggerHealthCheck(): Promise<number | null> {
  const origin = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const secret = process.env.CRON_SECRET ?? "";
  try {
    // 2s outer timeout — we just need the lambda to spawn; the
    // actual work completes in the background invocation.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    await fetch(`${origin}/api/cron/pool-health-check`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timer);
  } catch {
    // The fetch body never arrives (timed out) but the lambda is
    // spawned. That's fine — the next tick checks PoolJob.
  }
  // Return the job id if we can find a freshly-created one.
  const fresh = await prisma.poolJob.findFirst({
    where: { jobType: "health_check", status: { in: ["pending", "running"] } },
    orderBy: { id: "desc" },
  });
  return fresh?.id ?? null;
}

// Terminal statuses that mark a health-check job done (successfully
// or otherwise). "stuck" is terminal too — we unstuck downstream.
const TERMINAL = new Set(["completed", "stopped", "error", "stuck"]);

async function isHealthCheckDone(pausedAt: Date, jobId?: number): Promise<{
  done: boolean;
  jobId: number | null;
  invalidated: number;
}> {
  // Prefer the job we already linked; fall back to any job created
  // after the pause.
  const job = jobId
    ? await prisma.poolJob.findUnique({ where: { id: jobId } })
    : await prisma.poolJob.findFirst({
        where: {
          jobType: "health_check",
          startedAt: { gte: pausedAt },
        },
        orderBy: { id: "desc" },
      });
  if (!job) return { done: false, jobId: null, invalidated: 0 };
  const done = TERMINAL.has(job.status);
  const stats = (job.stats as { invalidated?: number } | null) ?? null;
  return { done, jobId: job.id, invalidated: stats?.invalidated ?? 0 };
}

// Re-run country detection on null-country accounts using cached
// username. Same logic as /api/pool/backfill-country but inline so
// the coordinator doesn't need to HTTP-hop.
async function reclassifyNullCountry(): Promise<number> {
  const rows = await prisma.testAccount.findMany({
    where: { countryConfidence: "unknown" },
    select: { id: true, username: true },
  });
  let updated = 0;
  for (const r of rows) {
    const det = detectAccountCountry({ username: r.username });
    if (det.confidence === "unknown") continue;
    await prisma.testAccount.update({
      where: { id: r.id },
      data: {
        detectedCountry: det.country,
        countryConfidence: det.confidence,
      },
    });
    updated++;
  }
  return updated;
}

async function countActivePool(platform = "instagram"): Promise<number> {
  return prisma.testAccount.count({
    where: { platform, status: "available", active: true },
  });
}

// Main tick — advances the state machine by one step. Safe to call
// concurrently; each branch is idempotent.
export async function tickCleanupCoordinator(): Promise<{
  ok: true;
  phase: CleanupPhase | "idle";
  detail: Record<string, unknown>;
}> {
  const session = await readSession();
  if (!session) return { ok: true, phase: "idle", detail: {} };

  const pausedAt = new Date(session.pausedAt);

  if (session.phase === "trigger") {
    const jobId = await triggerHealthCheck();
    const next: CleanupSession = {
      ...session,
      phase: "wait",
      healthCheckJobId: jobId ?? undefined,
    };
    await writeSession(next);
    return {
      ok: true,
      phase: "wait",
      detail: { triggeredHealthCheckJobId: jobId },
    };
  }

  if (session.phase === "wait") {
    const check = await isHealthCheckDone(pausedAt, session.healthCheckJobId);
    if (!check.done) {
      return {
        ok: true,
        phase: "wait",
        detail: { healthCheckJobId: check.jobId, done: false },
      };
    }
    // Job finished; move to finalize phase. We do the reclassify +
    // pool eval inline since they're both fast (<30s).
    const poolCountBefore = await countActivePool();
    const countryBackfilled = await reclassifyNullCountry();
    const poolCountAfter = await countActivePool();

    let action: "resumed" | "stayed_paused";
    if (poolCountAfter >= MIN_POOL_FOR_RESUME) {
      await prisma.scoringCampaign.update({
        where: { id: session.campaignId },
        data: { status: "running", stopReason: null },
      });
      action = "resumed";
    } else {
      await prisma.scoringCampaign.update({
        where: { id: session.campaignId },
        data: {
          status: "paused",
          stopReason: `pool_insufficient_after_cleanup:${poolCountAfter}`,
        },
      });
      action = "stayed_paused";
    }

    // Keep a summary in the row for 1 more tick so the dashboard
    // can show the result, then delete.
    const summary: CleanupSession = {
      ...session,
      phase: "finalize",
      healthCheckJobId: check.jobId ?? session.healthCheckJobId,
      lastResult: {
        at: new Date().toISOString(),
        poolCountBefore,
        poolCountAfter,
        invalidated: check.invalidated,
        countryBackfilled,
        action,
      },
    };
    await writeSession(summary);

    return {
      ok: true,
      phase: "finalize",
      detail: {
        poolCountBefore,
        poolCountAfter,
        invalidated: check.invalidated,
        countryBackfilled,
        action,
      },
    };
  }

  // phase === "finalize" — clean up the Config row on the next tick.
  await clearSession();
  return {
    ok: true,
    phase: "idle",
    detail: { cleared: true, lastResult: session.lastResult },
  };
}
