import { prisma } from "../src/lib/prisma";

async function main() {
  const all = await prisma.productServiceCandidate.findMany({
    select: { serviceId: true, lifecycleStatus: true },
  });
  const RANK: Record<string, number> = { NEW:0, TESTING:1, QUALIFIED:2, MONITORED:3, DEAD:4 };
  const best = new Map<number, string>();
  for (const r of all) {
    const cur = best.get(r.serviceId);
    if (!cur || RANK[r.lifecycleStatus] > RANK[cur]) {
      best.set(r.serviceId, r.lifecycleStatus);
    }
  }
  const counts: Record<string, number> = { NEW:0, TESTING:0, QUALIFIED:0, MONITORED:0, DEAD:0 };
  for (const v of Array.from(best.values())) counts[v]++;
  console.log("Current per-service lifecycle counts:");
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Total services: ${best.size}`);

  // Sanity: 11 originally-DEAD services
  const originals = [1862, 1736, 1857, 1858, 1859, 1860, 1861, 1732, 1843, 1730, 1863];
  const stillDead: number[] = [];
  const newStatus: Array<{ id: number; status: string; active: boolean }> = [];
  for (const id of originals) {
    const cands = await prisma.productServiceCandidate.findMany({
      where: { serviceId: id },
      select: { lifecycleStatus: true },
    });
    const svc = await prisma.service.findUnique({ where: { id }, select: { active: true } });
    if (cands.length === 0) {
      newStatus.push({ id, status: "no_candidates", active: svc?.active ?? false });
      continue;
    }
    let best2: string = "NEW";
    for (const c of cands) if (RANK[c.lifecycleStatus] > RANK[best2]) best2 = c.lifecycleStatus;
    newStatus.push({ id, status: best2, active: svc?.active ?? false });
    if (best2 === "DEAD") stillDead.push(id);
  }
  console.log(`\nOriginal 11 DEAD service status now:`);
  for (const s of newStatus) console.log(`  svc#${s.id}: ${s.status} active=${s.active}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
