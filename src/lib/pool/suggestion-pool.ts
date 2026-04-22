// Shared helpers for the seed-suggestions cache pool.
//
// Layout:
//   • PoolSeedSuggestionPool  — pre-generated handles, drained as operators
//                               integrate/reject, refilled by a cron + on-demand
//   • PoolSeedAccount         — active seeds actually used by the scraper
//   • PoolSeedSuggestionAction — decision log for integrated/rejected history
//
// The read path (fetchCachedSuggestions) is the hot path — it serves the
// /pool suggestions column in <50ms by hitting only the cache and filtering
// against the exclude set. The slow path (refillSuggestionPool) calls Claude
// Haiku to top the cache back up to 100, and falls back to the hardcoded
// lib/pool/suggested-seeds.ts list when Claude is unreachable.

import { prisma } from "@/lib/prisma";
import { suggestedSeedsFor } from "./suggested-seeds";

export const POOL_TARGET = 100; // keep the cache at this size (per platform)
export const POOL_REFILL_THRESHOLD = 50; // cron tops up when below this
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_TIMEOUT_MS = 30_000;
// Bumped 2048 → 4096 so a 100-username response has plenty of headroom
// even when Claude prefixes with whitespace / formatting it shouldn't.
const CLAUDE_MAX_TOKENS = 4096;

export type PlatformId = "instagram" | "tiktok";
export type SuggestionSource = "cache" | "claude" | "fallback";

export type RefillResult = {
  platform: PlatformId;
  before: number;
  after: number;
  added: number;
  source: "claude" | "fallback";
  error?: string;
};

// ── Read path ────────────────────────────────────────────────────────
export async function getPoolCount(platform: PlatformId): Promise<number> {
  return prisma.poolSeedSuggestionPool.count({ where: { platform } });
}

export async function fetchCachedSuggestions({
  platform,
  count,
  excludeSet,
}: {
  platform: PlatformId;
  count: number;
  excludeSet: Set<string>;
}): Promise<{ rows: string[]; total: number }> {
  // We over-fetch a little to have headroom after local dedupe, since the
  // cache and exclude set might overlap between rows we pull and entries
  // that were acted on between cache refill and this read.
  const raw = await prisma.poolSeedSuggestionPool.findMany({
    where: { platform, username: { notIn: Array.from(excludeSet) } },
    select: { username: true },
    orderBy: { createdAt: "asc" }, // oldest first so fresh generations rotate in last
    take: count * 3,
  });

  const seen = new Set<string>();
  const rows: string[] = [];
  for (const r of raw) {
    const key = r.username.toLowerCase();
    if (excludeSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    rows.push(r.username);
    if (rows.length >= count) break;
  }

  // Total that matches the exclude filter (used by the UI "pool reserve"
  // indicator). Cheaper than a full COUNT via a separate WHERE because
  // excludeSet is already applied on the fetch — we approximate here
  // with the cache size minus what the UI already has on screen.
  const total = await prisma.poolSeedSuggestionPool.count({
    where: { platform, username: { notIn: Array.from(excludeSet) } },
  });

  return { rows, total };
}

// ── Refill path (Claude + fallback) ──────────────────────────────────
// Brings the cache for `platform` up to POOL_TARGET. Called by:
//   • the 15-min cron  (unconditional if USABLE count < POOL_REFILL_THRESHOLD)
//   • the on-demand GET suggestions endpoint (fire-and-forget when low)
//   • POST /api/pool/seeds/refill-pool (manual / cold-start priming)
//
// Counts USABLE entries (cache rows that aren't already an active
// seed or in the decision log). The old "total count" check silently
// skipped real refills when the cache had 169 rows — all of which
// the user had already integrated — making the UI look stuck at
// "⟲ REMPLISSAGE..." forever.
export async function refillSuggestionPool(
  platform: PlatformId
): Promise<RefillResult> {
  const before = await getPoolCount(platform);

  // Build the exclude set first so we can compute the USABLE count
  // (cache entries the operator hasn't already seen / acted on).
  const [activeSeeds, acted, poolNow] = await Promise.all([
    prisma.poolSeedAccount.findMany({
      where: { platform },
      select: { username: true },
    }),
    prisma.poolSeedSuggestionAction.findMany({
      where: { platform },
      select: { username: true },
    }),
    prisma.poolSeedSuggestionPool.findMany({
      where: { platform },
      select: { username: true },
    }),
  ]);
  const userActedSet = new Set<string>([
    ...activeSeeds.map((s) => s.username.toLowerCase()),
    ...acted.map((s) => s.username.toLowerCase()),
  ]);
  const usableInCache = poolNow.filter(
    (p) => !userActedSet.has(p.username.toLowerCase())
  ).length;

  // Skip the Claude call only if the USABLE pool is already full.
  // Counting total rows (old behaviour) produced false positives once
  // the cache accumulated stale entries that had been integrated or
  // rejected by the operator.
  if (usableInCache >= POOL_TARGET) {
    console.log(
      `[REFILL] skip ${platform} · cache=${before} usable=${usableInCache} >= target=${POOL_TARGET}`
    );
    return { platform, before, after: before, added: 0, source: "claude" };
  }

  // Exclude set for Claude includes the current cache too — we don't
  // want to re-suggest handles that already live in it even if the
  // operator hasn't acted yet.
  const excludeSet = new Set<string>([
    ...Array.from(userActedSet),
    ...poolNow.map((s) => s.username.toLowerCase()),
  ]);

  // Try Claude first, fall back to the hardcoded pool.
  let candidates: string[] = [];
  let source: "claude" | "fallback" = "claude";
  let error: string | undefined;
  try {
    candidates = await fetchClaudeCandidates({ platform, excludeSet });
  } catch (e) {
    source = "fallback";
    error = (e as Error).message;
    console.error(
      `[refill] Claude failed for ${platform} (falling back): ${error}`
    );
    candidates = suggestedSeedsFor(platform).filter(
      (u) => !excludeSet.has(u.toLowerCase())
    );
  }

  // Local dedupe + exclude re-check (Claude sometimes ignores constraints).
  const seen = new Set<string>();
  const toInsert: string[] = [];
  for (const raw of candidates) {
    const cleaned = raw.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9._-]{1,30}$/.test(cleaned)) continue;
    if (excludeSet.has(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    toInsert.push(cleaned);
  }

  // Upsert in a single createMany — skipDuplicates handles the race where
  // another tab triggered a concurrent refill and populated the same handles.
  if (toInsert.length > 0) {
    await prisma.poolSeedSuggestionPool.createMany({
      data: toInsert.map((username) => ({ platform, username })),
      skipDuplicates: true,
    });
  }

  const after = await getPoolCount(platform);
  const result: RefillResult = {
    platform,
    before,
    after,
    added: after - before,
    source,
  };
  if (error) result.error = error;
  console.log(
    `[REFILL] Added ${result.added} new suggestions to pool (${platform}), total: ${after} · source=${source}`
  );
  return result;
}

async function fetchClaudeCandidates({
  platform,
  excludeSet,
}: {
  platform: PlatformId;
  excludeSet: Set<string>;
}): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Cap the exclude list we feed the model: we keep ~150 recent entries
  // so the prompt stays within a reasonable token budget while still
  // steering away from the most-likely repeat suggestions. Post-filter
  // locally against the FULL excludeSet, so caps here are purely for
  // prompt efficiency.
  const excludeArr = Array.from(excludeSet);
  const sample = excludeArr.slice(-150);
  const excludeStr = sample.length > 0 ? sample.join(", ") : "(aucun)";

  // Target the absolute biggest accounts. The more followers a seed
  // has, the more dormant candidates its /followers endpoint returns
  // per page, so bigger seeds = dramatically better scrape yield.
  // Previous prompt asked for "5M+" and got 5-20M handles; we now
  // explicitly nudge Claude toward 50M+ (IG) / 20M+ (TT).
  const prompt =
    platform === "instagram"
      ? `Donne-moi 100 comptes Instagram qui ont le PLUS DE FOLLOWERS ` +
        `actuellement. Vise prioritairement les comptes avec 50M+ followers ` +
        `(top mondial). Diverses catégories (musiciens, acteurs, sportifs, ` +
        `marques, influenceurs, comptes officiels, clubs sportifs, médias, ` +
        `etc.) et diverses régions (US, UK, FR, ES, latin america, asie, ` +
        `moyen-orient). Format : JSON array de strings (usernames sans @). ` +
        `Exclure : [${excludeStr}]. Répondre uniquement avec le JSON.`
      : `Donne-moi 100 comptes TikTok qui ont le PLUS DE FOLLOWERS ` +
        `actuellement. Vise prioritairement les comptes avec 20M+ followers ` +
        `(top mondial). Diverses catégories et régions. Format : JSON array ` +
        `de strings (usernames sans @). Exclure : [${excludeStr}]. ` +
        `Répondre uniquement avec le JSON.`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLAUDE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: CLAUDE_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
  if (!text) throw new Error("empty Claude response");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("no JSON array in response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("invalid JSON array");
  }
  if (!Array.isArray(parsed)) throw new Error("response is not an array");
  return parsed.filter((x): x is string => typeof x === "string");
}
