// Multi-key RapidAPI pool — manages the active-key lifecycle for a
// running job. Jobs get a key assigned round-robin at creation time
// (least-recently-used active key). Inside a job, the IG client
// calls currentKey() to know which token to use; if a call fails
// with "quota exceeded" the client calls switchOnCap() to pick the
// next active key and the job transparently continues on it.
//
// Context is scoped per-async-call-chain via AsyncLocalStorage so a
// tranche worker just wraps its body in withApiKey(...) and every
// nested IG call under that wrap sees the same (live-mutable) key
// ref — no prop drilling through the scraper / fill / health-check
// orchestrators.

import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@/lib/prisma";

export type ApiKeyCtx = {
  id: number;
  token: string;
  provider: string;
};

type Store = {
  current: ApiKeyCtx;
  jobId?: number;
};

const als = new AsyncLocalStorage<Store>();

export function withApiKey<T>(
  ctx: ApiKeyCtx,
  jobId: number | undefined,
  fn: () => Promise<T>
): Promise<T> {
  return als.run({ current: ctx, jobId }, fn);
}

export function currentKey(): ApiKeyCtx | null {
  return als.getStore()?.current ?? null;
}

// Round-robin: least recently used active key for the provider.
// excludeIds skips keys we already know are capped in this job (e.g.
// the one that just threw 429 quota).
export async function pickNextApiKey(
  provider: string,
  excludeIds: number[] = []
): Promise<ApiKeyCtx | null> {
  const row = await prisma.rapidApiKey.findFirst({
    where: {
      provider,
      status: "active",
      ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
    },
    orderBy: [{ lastUsedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  });
  if (!row) return null;
  return { id: row.id, token: row.token, provider: row.provider };
}

// Called by the IG client when a response looked like a monthly-cap
// 429. Caps the current key, picks the next one, rewires the ALS
// context + PoolJob.rapidApiKeyId so subsequent calls + the UI see
// the new key.
export async function switchOnCap(reason: string): Promise<ApiKeyCtx | null> {
  const store = als.getStore();
  if (!store) return null;
  const current = store.current;
  await prisma.rapidApiKey
    .update({
      where: { id: current.id },
      data: {
        status: "capped",
        lastCappedAt: new Date(),
      },
    })
    .catch(() => null);
  console.warn(
    `[rapidapi-keys] key#${current.id} (${current.provider}) capped: ${reason.slice(0, 120)}`
  );

  const next = await pickNextApiKey(current.provider, [current.id]);
  if (!next) return null;

  store.current = next;
  if (store.jobId) {
    await prisma.poolJob
      .update({
        where: { id: store.jobId },
        data: { rapidApiKeyId: next.id },
      })
      .catch(() => null);
  }
  console.log(
    `[rapidapi-keys] switched to key#${next.id} for job#${store.jobId ?? "?"}`
  );
  return next;
}

// ── Usage tracking ─────────────────────────────────────────────────
//
// Batched to avoid hammering the DB on every IG call. In-memory
// counter per keyId, flushed every 5s by a lazy interval. The
// flushUsage() helper is also called explicitly at tranche end so
// the final count lands with the status terminal.
const pending = new Map<number, number>();
let flushInterval: ReturnType<typeof setInterval> | null = null;

function ensureFlushInterval() {
  if (flushInterval) return;
  flushInterval = setInterval(() => {
    void flushUsage();
  }, 5_000);
  // Don't keep the process alive just for this timer in Node CLI
  // contexts (prisma scripts). Noop on Vercel.
  const unrefable = flushInterval as unknown as { unref?: () => void };
  unrefable.unref?.();
}

export function recordApiCall(): void {
  const key = currentKey();
  if (!key) return;
  pending.set(key.id, (pending.get(key.id) ?? 0) + 1);
  ensureFlushInterval();
}

export async function flushUsage(): Promise<void> {
  if (pending.size === 0) return;
  const entries = Array.from(pending.entries());
  pending.clear();
  for (const [keyId, count] of entries) {
    try {
      await prisma.rapidApiKey.update({
        where: { id: keyId },
        data: {
          quotaUsed: { increment: count },
          lastUsedAt: new Date(),
        },
      });
    } catch {
      // If the update fails (e.g. key deleted), drop the count. We
      // prefer data loss over infinite retry.
    }
  }
}

// Ensures at least one DB row exists for IG — seeded from the
// RAPIDAPI_KEY env var on first use so prod doesn't lose service
// while the operator hasn't populated the UI yet. Idempotent.
export async function ensureDefaultKeySeeded(): Promise<void> {
  const count = await prisma.rapidApiKey.count({
    where: { provider: "instagram" },
  });
  if (count > 0) return;
  const envToken = process.env.RAPIDAPI_KEY;
  if (!envToken) return;
  await prisma.rapidApiKey.create({
    data: {
      provider: "instagram",
      label: "default (from env var)",
      token: envToken,
      status: "active",
      quotaMonthly: 130_000,
      resetDayOfMonth: 2,
      rateLimitPerMin: 85,
    },
  });
  console.log("[rapidapi-keys] seeded default IG key from RAPIDAPI_KEY env");
}

// Picks the round-robin key for a new job + returns the full ctx.
// Returns null when the provider has no DB key AND no env fallback
// (caller should error out visibly).
export async function acquireKeyForNewJob(
  provider: string
): Promise<ApiKeyCtx | null> {
  await ensureDefaultKeySeeded();
  const picked = await pickNextApiKey(provider, []);
  if (picked) return picked;
  // No active DB key — fall back to env var so we never hard-break
  // prod when the table is temporarily empty.
  const envToken = process.env.RAPIDAPI_KEY;
  if (envToken && provider === "instagram") {
    return { id: -1, token: envToken, provider: "instagram" };
  }
  return null;
}

// Wraps a tranche runner with the appropriate ALS-scoped key. Every
// IG call underneath this wrap will see the current key through
// currentKey() + record usage + auto-failover on cap. Use inside
// every tranche worker (execute + runner + inline cron).
export async function withAssignedKey<T>(
  job: {
    id: number;
    rapidApiKeyId: number | null;
    platform: string | null;
    jobType: string;
  },
  fn: () => Promise<T>
): Promise<T> {
  // Which provider does this job touch? Most jobs use IG (scrape,
  // health-check, engagement-extract, engagement-fill). TT has its
  // own client which isn't gated by this manager — if a future
  // jobType goes through TT keys, we can key off platform here.
  const provider = "instagram";

  let ctx: ApiKeyCtx | null = null;

  // 1. Resolve the key already assigned to this job row (if still
  //    active).
  if (job.rapidApiKeyId) {
    const row = await prisma.rapidApiKey
      .findUnique({ where: { id: job.rapidApiKeyId } })
      .catch(() => null);
    if (row && row.status === "active" && row.provider === provider) {
      ctx = { id: row.id, token: row.token, provider: row.provider };
    }
  }

  // 2. No assigned key (freshly-created job from dual-dispatch where
  //    only the dispatcher stamped it) — pick one now.
  if (!ctx) {
    const fresh = await acquireKeyForNewJob(provider);
    if (fresh) {
      ctx = fresh;
      if (fresh.id !== -1) {
        await prisma.poolJob
          .update({
            where: { id: job.id },
            data: { rapidApiKeyId: fresh.id },
          })
          .catch(() => null);
      }
    }
  }

  // 3. No key available at all — run WITHOUT the ALS wrap. The IG
  //    client's currentKey() will return null and fall back to the
  //    env var directly. This keeps us running if the table is
  //    empty (first boot) and the env var still holds a token.
  if (!ctx) {
    return fn();
  }

  return withApiKey(ctx, job.id, async () => {
    try {
      return await fn();
    } finally {
      await flushUsage();
    }
  });
}
