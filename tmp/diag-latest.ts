import { prisma } from "../src/lib/prisma";

async function main() {
  // 10 most recent TestOrder regardless of status
  const latest = await prisma.testOrder.findMany({
    orderBy: { id: "desc" },
    take: 20,
    select: {
      id: true,
      bulkmedyaOrderId: true,
      status: true,
      dryRun: true,
      placedAt: true,
      service: { select: { bulkmedyaId: true, name: true, ratePerK: true } },
    },
  });
  console.log("══════ 20 derniers TestOrder ══════");
  for (const r of latest) {
    const ageM = Math.round((Date.now() - r.placedAt.getTime()) / 60_000);
    const kind = r.bulkmedyaOrderId.startsWith("sim-") ? "SIM" : "REAL";
    console.log(
      `  #${r.id} ${r.placedAt.toISOString()} [${kind}] status=${r.status} dryRun=${r.dryRun} bm=${r.bulkmedyaOrderId} age=${ageM}min BM#${r.service?.bulkmedyaId}`
    );
  }
  // And the max id ever
  const max = await prisma.testOrder.findFirst({
    orderBy: { id: "desc" },
    select: { id: true, placedAt: true, bulkmedyaOrderId: true },
  });
  console.log("\nmax TestOrder id:", max);

  // Toggle updatedAt to pin the flip moment (approximate)
  const t = await prisma.systemToggle.findUnique({ where: { id: 1 } });
  console.log(
    "toggles.updatedAt:",
    t?.updatedAt?.toISOString(),
    "dryRunMode:",
    t?.dryRunMode,
    "testBotEnabled:",
    t?.testBotEnabled
  );
  console.log("now:", new Date().toISOString());
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
