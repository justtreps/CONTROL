// Timeline des 128 TestOrder running + git log du deploy dryRun.
import { prisma } from "../src/lib/prisma";

async function main() {
  const running = await prisma.testOrder.findMany({
    where: { status: "running" },
    orderBy: { placedAt: "desc" },
    select: {
      id: true,
      bulkmedyaOrderId: true,
      dryRun: true,
      placedAt: true,
      pollingState: true,
    },
  });

  const real = running.filter((r) => !r.bulkmedyaOrderId.startsWith("sim-"));
  const sim = running.filter((r) => r.bulkmedyaOrderId.startsWith("sim-"));

  console.log("══════ 36 real-id TestOrder running ══════");
  console.log("id | placedAt | bmOrderId | pollingState? | age");
  for (const r of real) {
    const ageH = Math.floor((Date.now() - r.placedAt.getTime()) / 3600_000);
    const hasPoll = r.pollingState !== null;
    console.log(
      `  #${r.id} ${r.placedAt.toISOString()} bm=${r.bulkmedyaOrderId} poll=${hasPoll} age=${ageH}h`
    );
  }

  console.log("\n══════ 92 sim-* TestOrder running (last 10) ══════");
  for (const r of sim.slice(0, 10)) {
    const ageH = Math.floor((Date.now() - r.placedAt.getTime()) / 3600_000);
    const hasPoll = r.pollingState !== null;
    console.log(
      `  #${r.id} ${r.placedAt.toISOString()} bm=${r.bulkmedyaOrderId} poll=${hasPoll} age=${ageH}h`
    );
  }

  // How many sim have pollingState null? Those can't be finalized
  // by the poller cron.
  const simNoPoll = sim.filter((r) => r.pollingState === null).length;
  const simWithPoll = sim.filter((r) => r.pollingState !== null).length;
  const realNoPoll = real.filter((r) => r.pollingState === null).length;
  const realWithPoll = real.filter((r) => r.pollingState !== null).length;
  console.log(
    `\npollingState distribution:\n  sim: null=${simNoPoll} set=${simWithPoll}\n  real: null=${realNoPoll} set=${realWithPoll}`
  );

  // Measurement coverage for the real ones — if 0 post-T+0 measurements
  // exist for most, polling isn't hitting them.
  console.log("\n══════ measurement coverage for real rows ══════");
  for (const r of real) {
    const mCount = await prisma.measurement.count({
      where: {
        testOrderId: r.id,
        checkpoint: { not: "T+0" },
      },
    });
    const pCount = await prisma.testPoll.count({
      where: { testOrderId: r.id },
    });
    console.log(`  #${r.id} measurements(non-T+0)=${mCount} polls=${pCount}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
