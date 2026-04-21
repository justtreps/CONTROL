// Dynamic seed suggestions endpoint — asks Claude Haiku to propose
// N popular IG/TikTok handles that aren't already known (active seed
// or previously integrated/rejected via PoolSeedSuggestionAction).
//
// GET ?platform=instagram|tiktok&count=10
//   → { rows: [{ platform, username }], total, source: "claude"|"fallback" }
//
// Replaces /api/pool/seeds/suggestions GET (which served from a
// hardcoded list). That route still handles POST (integrate/reject)
// and remains untouched so the decision log keeps working.
//
// Fallback: if the Claude call fails (no ANTHROPIC_API_KEY, rate
// limit, parse error, network timeout), we serve from the old
// hardcoded pool in lib/pool/suggested-seeds.ts with a daily-rotation
// shuffle. The UI receives `source: "fallback"` so it can surface a
// small hint if it wants.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { suggestedSeedsFor } from "@/lib/pool/suggested-seeds";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_TIMEOUT_MS = 12_000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const count = Math.min(
    20,
    Math.max(1, Number(url.searchParams.get("count") ?? 10) || 10)
  );

  if (platform !== "instagram" && platform !== "tiktok") {
    return NextResponse.json(
      { error: "platform must be instagram or tiktok" },
      { status: 400 }
    );
  }

  // Build the exclusion set from DB: every seed currently known
  // (active or disabled) + every username ever integrated or rejected.
  const [activeSeeds, actedOn] = await Promise.all([
    prisma.poolSeedAccount.findMany({
      where: { platform },
      select: { username: true },
    }),
    prisma.poolSeedSuggestionAction.findMany({
      where: { platform },
      select: { username: true },
    }),
  ]);

  const excludeSet = new Set<string>([
    ...activeSeeds.map((s) => s.username.toLowerCase()),
    ...actedOn.map((s) => s.username.toLowerCase()),
  ]);

  // --- Try Claude first ----------------------------------------------
  try {
    const usernames = await fetchClaudeSuggestions({
      platform,
      count,
      exclude: Array.from(excludeSet),
    });

    // Post-filter: Claude occasionally ignores the exclude list, and
    // may return duplicates. Dedupe + re-apply exclude locally so the
    // UI never shows a handle the user already acted on.
    const seen = new Set<string>();
    const filtered: string[] = [];
    for (const u of usernames) {
      const key = u.toLowerCase();
      if (excludeSet.has(key) || seen.has(key)) continue;
      seen.add(key);
      filtered.push(u);
    }

    return NextResponse.json({
      rows: filtered.slice(0, count).map((username) => ({ platform, username })),
      total: filtered.length,
      source: "claude",
    });
  } catch (e) {
    // --- Fallback: hardcoded pool ------------------------------------
    console.error(
      "[suggestions-dynamic] Claude call failed, falling back:",
      (e as Error).message
    );
    return NextResponse.json(fallback({ platform, count, excludeSet }));
  }
}

// ── Claude call ──────────────────────────────────────────────────────
async function fetchClaudeSuggestions({
  platform,
  count,
  exclude,
}: {
  platform: "instagram" | "tiktok";
  count: number;
  exclude: string[];
}): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Cap the exclude list in the prompt so we don't bloat tokens.
  // 80 handles is plenty of anti-duplication signal while staying
  // well under any practical prompt budget.
  const excludeSample = exclude.slice(0, 80);
  const excludeStr =
    excludeSample.length > 0 ? excludeSample.join(", ") : "(aucun)";

  const platformName = platform === "instagram" ? "Instagram" : "TikTok";

  const prompt =
    `Donne-moi ${count} comptes ${platformName} réels avec plus de 5M followers, ` +
    `format JSON array de strings (juste les usernames sans @). ` +
    `Exclure : [${excludeStr}]. ` +
    `Répondre uniquement avec le JSON, rien d'autre.`;

  // Abort after CLAUDE_TIMEOUT_MS so a hung provider doesn't pin the
  // serverless invocation to its max duration.
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
        max_tokens: 512,
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

  const text =
    data.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
  if (!text) throw new Error("empty Claude response");

  // Pull the first [...] array out of the response. Claude sometimes
  // wraps it in prose or code fences despite the instruction, so we're
  // defensive about the shape.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error("no JSON array in response");

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("invalid JSON array");
  }

  if (!Array.isArray(parsed)) throw new Error("response is not an array");

  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim().replace(/^@/, "").toLowerCase();
    // Basic sanity: usernames are 1-30 chars, a-z0-9._ (IG). TikTok
    // allows underscores and dots too. Reject anything that looks
    // like a sentence or URL leak.
    if (!/^[a-z0-9._-]{1,30}$/.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

// ── Fallback: hardcoded list w/ daily rotation ──────────────────────
function fallback({
  platform,
  count,
  excludeSet,
}: {
  platform: "instagram" | "tiktok";
  count: number;
  excludeSet: Set<string>;
}) {
  const all = suggestedSeedsFor(platform);
  const candidates = all.filter((u) => !excludeSet.has(u.toLowerCase()));
  const seed = `${platform}-${new Date().toISOString().slice(0, 10)}`;
  candidates.sort((a, b) => {
    const ha = simpleHash(`${seed}|${a.toLowerCase()}`);
    const hb = simpleHash(`${seed}|${b.toLowerCase()}`);
    return ha - hb;
  });
  return {
    rows: candidates.slice(0, count).map((username) => ({ platform, username })),
    total: candidates.length,
    source: "fallback" as const,
  };
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
