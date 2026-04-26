import { prisma } from "../src/lib/prisma";

async function main() {
  // 1. Active brute campaigns
  const bruteCampaigns = await prisma.scoringCampaign.findMany({
    where: { stopReason: "brute_mode" },
    orderBy: { id: "desc" },
    take: 5,
  });
  console.log(`=== Recent brute campaigns ===`);
  for (const c of bruteCampaigns) {
    const remaining = c.targetServiceIds.length - c.placedServiceIds.length;
    console.log(
      `campaign#${c.id} status=${c.status} target=${c.targetServiceIds.length} placed=${c.placedCount} failed=${c.abortedCount} remaining=${remaining}  startedAt=${c.startedAt.toISOString()}  finishedAt=${c.finishedAt?.toISOString() ?? "—"}`
    );
  }

  // 2. Current balance retry budget
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const stamped = await prisma.service.findMany({
    where: {
      lastPlacementErrorAt: { gte: since },
      lastPlacementError: { not: null },
    },
    select: {
      id: true,
      lastPlacementError: true,
      lastPlacementErrorAt: true,
    },
    orderBy: { lastPlacementErrorAt: "desc" },
    take: 10,
  });
  const total = await prisma.service.count({
    where: {
      lastPlacementErrorAt: { gte: since },
      lastPlacementError: { not: null },
    },
  });
  console.log(`\n=== Services with lastPlacementError in 24h ===`);
  console.log(`Total: ${total}`);
  console.log(`Top 10 most recent stamps:`);
  for (const s of stamped) {
    console.log(`  svc#${s.id} ${s.lastPlacementErrorAt?.toISOString().slice(11, 19)} → "${s.lastPlacementError?.slice(0, 100)}"`);
  }

  // 3. Distribution: backfilled vs live
  const backfilled = await prisma.service.count({
    where: {
      lastPlacementError: { contains: "backfilled" },
    },
  });
  const live = await prisma.service.count({
    where: {
      lastPlacementErrorAt: { gte: since },
      lastPlacementError: { not: null },
      NOT: { lastPlacementError: { contains: "backfilled" } },
    },
  });
  console.log(`\n=== Backfilled vs live ===`);
  console.log(`  backfilled (synthetic) : ${backfilled}`);
  console.log(`  live (real BulkMedya error): ${live}`);

  // 4. Sample 5 LIVE errors (the real ones from any retry attempts)
  const liveErrors = await prisma.service.findMany({
    where: {
      lastPlacementErrorAt: { gte: since },
      NOT: { lastPlacementError: { contains: "backfilled" } },
      lastPlacementError: { not: null },
    },
    select: { id: true, lastPlacementError: true, lastPlacementErrorAt: true, name: true },
    orderBy: { lastPlacementErrorAt: "desc" },
    take: 10,
  });
  if (liveErrors.length > 0) {
    console.log(`\n=== 10 most recent LIVE errors (from real BulkMedya rejections) ===`);
    for (const e of liveErrors) {
      console.log(`  svc#${e.id} ${e.lastPlacementErrorAt?.toISOString().slice(11, 19)} → "${e.lastPlacementError?.slice(0, 120)}"`);
    }
  } else {
    console.log(`\n=== No LIVE errors recorded — retry hasn't been triggered yet OR all stamps are still backfilled ===`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
