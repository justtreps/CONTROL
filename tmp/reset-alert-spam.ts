import { prisma } from "../src/lib/prisma";

async function main() {
  // Reset triggerCount for currently-active alerts to 1 — gives
  // the operator a clean slate. Going forward, the engine won't
  // increment on subsequent ticks (per the new logic).
  const r = await prisma.alert.updateMany({
    where: {
      status: { in: ["active", "acknowledged"] },
      triggerCount: { gt: 1 },
    },
    data: { triggerCount: 1 },
  });
  console.log(`Reset triggerCount on ${r.count} active alerts`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
