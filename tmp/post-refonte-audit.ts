import { prisma } from "../src/lib/prisma";
import { computeOrderScore } from "../src/lib/scoring";

async function main() {
  // ── 1. svc#889 deep check ──────────────────────────
  console.log("=== 1. svc#889 (BM 16890) ===");
  const svc889 = await prisma.service.findUnique({
    where: { id: 889 },
    include: {
      scores: { orderBy: { computedAt: "desc" }, take: 3 },
      testOrders: { include: { measurements: true }, orderBy: { placedAt: "desc" } },
    },
  });
  if (svc889) {
    console.log(`Latest 3 ServiceScore:`);
    for (const s of svc889.scores) {
      console.log(`  computedAt=${s.computedAt.toISOString().slice(11, 19)} curr=${s.currentScore.toFixed(1)} liv=${(s.completionFactor*25).toFixed(1)} vit=${s.speedScore.toFixed(1)} drop=${s.dropScore.toFixed(1)}`);
    }
    console.log(`\nTestOrders:`);
    for (const o of svc889.testOrders) {
      const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
      const delivered = peak - o.baselineCount;
      console.log(`  TO#${o.id} status=${o.status} baseline=${o.baselineCount} peak=${peak} delivered=${delivered}/${o.targetQuantity} placedAt=${o.placedAt.toISOString().slice(0, 16)} completedAt=${o.completedAt?.toISOString().slice(0, 16) ?? "—"}`);
    }
  }

  // ── 2. Top 10 by currentScore (raw DB) ─────────────
  console.log("\n=== 2. Top 10 DB ServiceScore (latest per service) ===");
  const all = await prisma.serviceScore.findMany({
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { computedAt: "desc" }],
  });
  const sortedDesc = [...all].sort((a, b) => b.currentScore - a.currentScore);
  for (let i = 0; i < 10; i++) {
    const s = sortedDesc[i];
    console.log(`  #${i+1} svc#${s.serviceId} total=${s.currentScore.toFixed(1)} liv=${(s.completionFactor*25).toFixed(1)} vit=${s.speedScore.toFixed(1)} drop=${s.dropScore.toFixed(1)}`);
  }

  // ── 3. 5 random services, manual recompute ────────
  console.log("\n=== 3. 5 random services — manual recompute vs DB ===");
  const sample = sortedDesc.filter((_, i) => i % 200 === 0).slice(0, 5);
  for (const ss of sample) {
    const latestOrder = await prisma.testOrder.findFirst({
      where: { serviceId: ss.serviceId, status: { in: ["completed", "completed_partial"] } },
      include: { measurements: true },
      orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { placedAt: "desc" }],
    });
    if (!latestOrder) continue;
    const allCosts = await prisma.service.findMany({
      where: { active: true, testOrders: { some: { status: { in: ["completed","completed_partial"] } } } },
      select: { id: true, ratePerK: true, minQuantity: true, maxQuantity: true },
    });
    const costs = allCosts.map((s) => {
      const qty = Math.max(20, s.minQuantity);
      if (s.maxQuantity > 0 && qty > s.maxQuantity) return null;
      return { id: s.id, cost: (s.ratePerK * qty) / 1000 };
    }).filter((v): v is { id: number; cost: number } => v !== null).sort((a,b) => a.cost - b.cost);
    const idx = costs.findIndex((c) => c.id === ss.serviceId);
    const costPercentile = idx < 0 ? 0.5 : (costs.length > 1 ? idx / (costs.length - 1) : 0.5);

    const recomputed = computeOrderScore(latestOrder, costPercentile);
    const dbTotal = ss.currentScore;
    const drift = Math.abs(recomputed.final - dbTotal);
    console.log(`  svc#${ss.serviceId} db=${dbTotal.toFixed(1)} recomputed=${recomputed.final.toFixed(1)} drift=${drift.toFixed(2)} ${drift > 5 ? "⚠ BUG" : "✓"}`);
    console.log(`    DB:        liv=${(ss.completionFactor*25).toFixed(1)} vit=${ss.speedScore.toFixed(1)} drop=${ss.dropScore.toFixed(1)}`);
    console.log(`    Recompute: liv=${recomputed.livraisonPts.toFixed(1)} vit=${recomputed.vitessePts.toFixed(1)} drop=${recomputed.dropPts.toFixed(1)} cout=${recomputed.coutPts.toFixed(1)}`);
  }

  // ── 4. Stagnant TestOrders verification ────────────
  console.log("\n=== 4. completed_partial verification (3 random) ===");
  const partials = await prisma.testOrder.findMany({
    where: { status: "completed_partial" },
    take: 3,
    include: { measurements: { orderBy: { checkedAt: "desc" }, take: 5 } },
  });
  for (const p of partials) {
    const post = p.measurements.filter((m) => m.checkpoint !== "T+0").slice(0, 3);
    const same = post.length === 3 && post.every((m) => m.actualCount === post[0].actualCount);
    console.log(`  TO#${p.id} svc#${p.serviceId} measurements=${p.measurements.length} last3=[${post.map((m)=>m.actualCount).join(",")}] sameCount=${same ? "✓" : "✗"}`);
  }

  // ── 5+6. Lifecycle vs score consistency ────────────
  console.log("\n=== 5+6. Lifecycle vs currentScore ===");
  const candWithScore = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true, currentScore: true },
  });
  const RANK: Record<string, number> = {NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4, PLACEMENT_FAILED:5, REMOVED_FROM_BULKMEDYA:6, PERMANENTLY_FAILED:7, DEPRECATED_PRODUCT:8};
  const best = new Map<number, { status: string; score: number | null }>();
  for (const c of candWithScore) {
    const cur = best.get(c.serviceId);
    if (!cur || RANK[c.lifecycleStatus] > RANK[cur.status]) {
      best.set(c.serviceId, { status: c.lifecycleStatus, score: c.currentScore });
    }
  }
  const bucketsByStatus: Record<string, { withScore: number; nullScore: number; zeroScore: number; pos: number; sum: number }> = {};
  for (const v of Array.from(best.values())) {
    if (!bucketsByStatus[v.status]) bucketsByStatus[v.status] = { withScore: 0, nullScore: 0, zeroScore: 0, pos: 0, sum: 0 };
    if (v.score === null) bucketsByStatus[v.status].nullScore++;
    else {
      bucketsByStatus[v.status].withScore++;
      if (v.score < 0.5) bucketsByStatus[v.status].zeroScore++;
      else { bucketsByStatus[v.status].pos++; bucketsByStatus[v.status].sum += v.score; }
    }
  }
  for (const [status, b] of Object.entries(bucketsByStatus).sort((a,b) => b[1].withScore - a[1].withScore)) {
    const avg = b.pos > 0 ? (b.sum / b.pos).toFixed(1) : "—";
    console.log(`  ${status.padEnd(25)} withScore=${b.withScore} nullScore=${b.nullScore} zero(<0.5)=${b.zeroScore} avg(>0)=${avg}`);
  }

  // ── 7. Score=0 services in QUALIFIED/MONITORED (suspect) ──
  console.log("\n=== 7. Suspect: QUALIFIED/MONITORED with currentScore < 1 ===");
  const suspects = await prisma.productServiceCandidate.findMany({
    where: {
      lifecycleStatus: { in: ["QUALIFIED", "MONITORED"] },
      currentScore: { lt: 1, not: null },
    },
    distinct: ["serviceId"],
    select: { serviceId: true, lifecycleStatus: true, currentScore: true },
    take: 10,
  });
  console.log(`  ${suspects.length} found (sample 10):`);
  for (const s of suspects) {
    const orders = await prisma.testOrder.findMany({
      where: { serviceId: s.serviceId, status: { in: ["completed", "completed_partial"] } },
      include: { measurements: true },
      orderBy: { completedAt: "desc" },
      take: 3,
    });
    console.log(`  svc#${s.serviceId} status=${s.lifecycleStatus} score=${s.currentScore?.toFixed(2)} testOrders=${orders.length}`);
    for (const o of orders.slice(0, 1)) {
      const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
      console.log(`    latest TO#${o.id} status=${o.status} baseline=${o.baselineCount} peak=${peak} delivered=${peak - o.baselineCount}`);
    }
  }

  // ── 8. Recent placement rate ────────────────────────
  const recent1h = await prisma.testOrder.count({ where: { placedAt: { gte: new Date(Date.now() - 3600_000) } } });
  console.log(`\n=== 8. TestOrders placés dernière 1h: ${recent1h} ===`);

  // ── 9. Code refs to old Bayesian fields (besides legitimate schema fallbacks) ──
  // Just count: weightedScore / sampleCount / Bayesian explicit references
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
