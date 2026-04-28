import { prisma } from "../src/lib/prisma";

async function main() {
  const svc = await prisma.service.findFirst({
    where: { bulkmedyaId: 16890 },
    include: {
      testOrders: { include: { measurements: true } },
      scores: { orderBy: { computedAt: "desc" }, take: 3 },
    },
  });
  if (!svc) { console.log("not found"); return; }
  console.log(`Service id=${svc.id} bulkmedyaId=${svc.bulkmedyaId}`);
  console.log(`TestOrders total: ${svc.testOrders.length}`);
  const completed = svc.testOrders.filter((o) => o.status === "completed");
  console.log(`  completed: ${completed.length}`);
  const valid = completed.filter((o) => {
    const peak = Math.max(o.baselineCount, ...o.measurements.map((m) => m.actualCount));
    return peak > o.baselineCount;
  });
  console.log(`  RULE-1 valid: ${valid.length}`);
  console.log(`\nLatest 3 ServiceScore:`);
  for (const s of svc.scores) {
    console.log(`  computedAt=${s.computedAt.toISOString().slice(11, 19)} weighted=${s.currentScore.toFixed(2)} raw=${s.rawScore.toFixed(2)} n=${s.sampleCount} comp=${(s.completionFactor*100).toFixed(0)} speed=${s.speedScore.toFixed(0)} drop=${s.dropScore.toFixed(0)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
