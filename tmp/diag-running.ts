// Diagnostic — 128 TestOrder status='running', 3-4 visibles sur BulkMedya.
// On cherche : combien sont des sim-*, combien ont dryRun=true/false,
// distribution par service, dates de placement, state toggles.

import { prisma } from "../src/lib/prisma";

async function main() {
  // Global state
  const toggles = await prisma.systemToggle.findUnique({ where: { id: 1 } });
  console.log("══════ toggles ══════");
  console.log({
    testBotEnabled: toggles?.testBotEnabled,
    dryRunMode: toggles?.dryRunMode,
    scoringEngineEnabled: toggles?.scoringEngineEnabled,
    adaptivePollingEnabled: toggles?.adaptivePollingEnabled,
    workflowExecutorEnabled: toggles?.workflowExecutorEnabled,
    updatedAt: toggles?.updatedAt?.toISOString(),
  });

  // Running orders — total + split by dryRun + bulkmedyaOrderId prefix
  const running = await prisma.testOrder.findMany({
    where: { status: "running" },
    select: {
      id: true,
      bulkmedyaOrderId: true,
      dryRun: true,
      placedAt: true,
      serviceId: true,
      retryCount: true,
      lastHealthCheckAt: true,
    },
    orderBy: { placedAt: "desc" },
  });

  console.log(`\n══════ TestOrder status='running' total = ${running.length} ══════`);

  const simRows = running.filter((r) => r.bulkmedyaOrderId.startsWith("sim-"));
  const realRows = running.filter((r) => !r.bulkmedyaOrderId.startsWith("sim-"));

  console.log({
    withSimPrefix: simRows.length,
    withRealId: realRows.length,
    dryRunTrue: running.filter((r) => r.dryRun).length,
    dryRunFalse: running.filter((r) => !r.dryRun).length,
  });

  // Cross-check: rows with dryRun=true but real id, or dryRun=false but sim id
  const mismatch = running.filter(
    (r) =>
      (r.dryRun && !r.bulkmedyaOrderId.startsWith("sim-")) ||
      (!r.dryRun && r.bulkmedyaOrderId.startsWith("sim-"))
  );
  console.log(`\nmismatch (dryRun flag vs id prefix) = ${mismatch.length}`);
  for (const m of mismatch.slice(0, 10)) {
    console.log(
      `  #${m.id} dryRun=${m.dryRun} id="${m.bulkmedyaOrderId.slice(0, 30)}" retry=${m.retryCount}`
    );
  }

  // Distribution by service for REAL rows
  console.log("\n══════ real-id rows by service ══════");
  const byService: Record<number, { count: number; ids: string[] }> = {};
  for (const r of realRows) {
    if (!byService[r.serviceId])
      byService[r.serviceId] = { count: 0, ids: [] };
    byService[r.serviceId].count++;
    if (byService[r.serviceId].ids.length < 3)
      byService[r.serviceId].ids.push(r.bulkmedyaOrderId);
  }
  const svcRows = await prisma.service.findMany({
    where: { id: { in: Object.keys(byService).map(Number) } },
    select: { id: true, name: true, platform: true, bulkmedyaId: true },
  });
  const svcMap = new Map(svcRows.map((s) => [s.id, s]));
  for (const [sidStr, v] of Object.entries(byService).sort(
    (a, b) => b[1].count - a[1].count
  )) {
    const sid = Number(sidStr);
    const s = svcMap.get(sid);
    console.log(
      `  service#${sid} (BM#${s?.bulkmedyaId}) "${s?.name?.slice(0, 60)}" → ${v.count} running rows, sample ids: ${v.ids.join(", ")}`
    );
  }

  // Dry-run rows: sample platform distribution
  console.log("\n══════ sim-* rows sample (first 5) ══════");
  for (const r of simRows.slice(0, 5)) {
    console.log(
      `  #${r.id} dryRun=${r.dryRun} id="${r.bulkmedyaOrderId.slice(0, 30)}" placedAt=${r.placedAt.toISOString()}`
    );
  }

  // Age distribution
  const now = Date.now();
  const ageBuckets = { h1: 0, h6: 0, h24: 0, d7: 0, older: 0 };
  for (const r of running) {
    const age = now - r.placedAt.getTime();
    if (age < 3600_000) ageBuckets.h1++;
    else if (age < 6 * 3600_000) ageBuckets.h6++;
    else if (age < 24 * 3600_000) ageBuckets.h24++;
    else if (age < 7 * 24 * 3600_000) ageBuckets.d7++;
    else ageBuckets.older++;
  }
  console.log("\n══════ age distribution of running rows ══════");
  console.log(ageBuckets);

  // Extreme: oldest running row
  const oldest = running[running.length - 1];
  if (oldest) {
    const ageH = Math.floor(
      (Date.now() - oldest.placedAt.getTime()) / 3600_000
    );
    console.log(`\noldest running row: #${oldest.id} placed ${ageH}h ago`);
  }

  // Historical: last 24h split
  const last24 = new Date(Date.now() - 24 * 3600_000);
  const [last24All, last24Real, last24Sim] = await Promise.all([
    prisma.testOrder.count({ where: { placedAt: { gte: last24 } } }),
    prisma.testOrder.count({
      where: { placedAt: { gte: last24 }, dryRun: false },
    }),
    prisma.testOrder.count({
      where: { placedAt: { gte: last24 }, dryRun: true },
    }),
  ]);
  console.log("\n══════ TestOrder placed last 24h ══════");
  console.log({ total: last24All, real: last24Real, sim: last24Sim });

  // Completed ratio last 7d
  const last7 = new Date(Date.now() - 7 * 24 * 3600_000);
  const [c7total, c7completed, c7aborted, c7running, c7real] =
    await Promise.all([
      prisma.testOrder.count({ where: { placedAt: { gte: last7 } } }),
      prisma.testOrder.count({
        where: { placedAt: { gte: last7 }, status: "completed" },
      }),
      prisma.testOrder.count({
        where: { placedAt: { gte: last7 }, status: "aborted_target_died" },
      }),
      prisma.testOrder.count({
        where: { placedAt: { gte: last7 }, status: "running" },
      }),
      prisma.testOrder.count({
        where: { placedAt: { gte: last7 }, dryRun: false },
      }),
    ]);
  console.log("\n══════ last 7d TestOrder breakdown ══════");
  console.log({
    total: c7total,
    completed: c7completed,
    aborted: c7aborted,
    running: c7running,
    real: c7real,
  });

  // RoutingDecision inspection — real orders from /api/order also
  // land as BulkMedya placements. Count them too.
  const lastDay = new Date(Date.now() - 24 * 3600_000);
  const [rdSuccess, rdFail, rdReal] = await Promise.all([
    prisma.routingDecision.count({
      where: { decidedAt: { gte: lastDay }, success: true },
    }),
    prisma.routingDecision.count({
      where: { decidedAt: { gte: lastDay }, success: false },
    }),
    prisma.routingDecision.count({
      where: { decidedAt: { gte: lastDay }, dryRun: false, success: true },
    }),
  ]);
  console.log("\n══════ RoutingDecision last 24h ══════");
  console.log({
    success: rdSuccess,
    failed: rdFail,
    realOrdersPlaced: rdReal,
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
