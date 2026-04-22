// Seed suggestions endpoint. Surfaces unused handles from the
// hardcoded pool (lib/pool/suggested-seeds.ts) so an operator can
// bulk-add seeds without hand-typing handles.
//
// GET  ?platform=instagram|tiktok&count=10
//   Returns up to `count` usernames that are NOT already in
//   PoolSeedAccount AND NOT in PoolSeedSuggestionAction (already
//   integrated or previously rejected).
//
// POST body { platform, integrate?: string[], reject?: string[] }
//   integrate: for each username, upsert into PoolSeedAccount (enabled
//     + priority 0) AND record action='integrated' in the decision log.
//   reject: record action='rejected' only (no seed creation).

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { suggestedSeedsFor } from "@/lib/pool/suggested-seeds";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const platform = url.searchParams.get("platform");
  const count = Math.min(
    50,
    Math.max(1, Number(url.searchParams.get("count") ?? 10) || 10)
  );

  if (platform !== "instagram" && platform !== "tiktok") {
    return NextResponse.json(
      { error: "platform must be instagram or tiktok" },
      { status: 400 }
    );
  }

  const all = suggestedSeedsFor(platform);
  if (all.length === 0) return NextResponse.json({ rows: [], total: 0 });

  // Exclusions: already in PoolSeedAccount OR acted on (integrated/rejected)
  const [already, acted] = await Promise.all([
    prisma.poolSeedAccount.findMany({
      where: { platform, username: { in: all } },
      select: { username: true },
    }),
    prisma.poolSeedSuggestionAction.findMany({
      where: { platform, username: { in: all } },
      select: { username: true },
    }),
  ]);

  const exclude = new Set<string>([
    ...already.map((r) => r.username.toLowerCase()),
    ...acted.map((r) => r.username.toLowerCase()),
  ]);

  const candidates = all.filter((u) => !exclude.has(u.toLowerCase()));
  // Deterministic-ish rotation: shuffle by hashing the platform + day so
  // repeat GETs within the same day return the same order, but each day
  // offers a fresh slice if the pool doesn't consume them all.
  const seed = `${platform}-${new Date().toISOString().slice(0, 10)}`;
  candidates.sort((a, b) => {
    const ha = simpleHash(`${seed}|${a.toLowerCase()}`);
    const hb = simpleHash(`${seed}|${b.toLowerCase()}`);
    return ha - hb;
  });

  const rows = candidates.slice(0, count).map((username) => ({
    platform,
    username,
  }));
  return NextResponse.json({
    rows,
    total: candidates.length,
    poolSize: all.length,
  });
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

const postSchema = z
  .object({
    platform: z.enum(["instagram", "tiktok"]),
    integrate: z.array(z.string().min(1).max(64)).optional(),
    reject: z.array(z.string().min(1).max(64)).optional(),
  })
  .refine((v) => (v.integrate?.length ?? 0) + (v.reject?.length ?? 0) > 0, {
    message: "at least one of integrate / reject must be non-empty",
  });

export async function POST(req: Request) {
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { platform, integrate = [], reject = [] } = parsed.data;

  let integrated = 0;
  let rejected = 0;

  for (const username of integrate) {
    // Upsert the seed row (enabled, priority 0) + log the decision
    // + drop the row from the cache so the refill's USABLE-count
    // check sees the freed slot.
    await prisma.$transaction(async (tx) => {
      await tx.poolSeedAccount.upsert({
        where: { platform_username: { platform, username } },
        update: { enabled: true },
        create: { platform, username, enabled: true, priority: 0 },
      });
      await tx.poolSeedSuggestionAction.upsert({
        where: { platform_username: { platform, username } },
        update: { action: "integrated" },
        create: { platform, username, action: "integrated" },
      });
      await tx.poolSeedSuggestionPool.deleteMany({
        where: { platform, username },
      });
    });
    integrated++;
  }

  for (const username of reject) {
    await prisma.$transaction(async (tx) => {
      await tx.poolSeedSuggestionAction.upsert({
        where: { platform_username: { platform, username } },
        update: { action: "rejected" },
        create: { platform, username, action: "rejected" },
      });
      await tx.poolSeedSuggestionPool.deleteMany({
        where: { platform, username },
      });
    });
    rejected++;
  }

  return NextResponse.json({ ok: true, integrated, rejected });
}
