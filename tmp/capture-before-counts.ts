// Snapshot of current classifier state before rematchAll. Used to
// compute the delta after the deploy runs.
import { prisma } from "../src/lib/prisma";

async function main() {
  const products = await prisma.myBoostProduct.findMany({ select: { id: true, slug: true } });
  const out: Record<string, { eligible: number; ineligible: number }> = {};
  for (const p of products) {
    const eligible = await prisma.productServiceCandidate.count({
      where: { productId: p.id, isEligible: true },
    });
    const ineligible = await prisma.productServiceCandidate.count({
      where: { productId: p.id, isEligible: false },
    });
    out[p.slug] = { eligible, ineligible };
  }
  const services = await prisma.service.count();
  const matched = await prisma.productServiceCandidate.groupBy({
    by: ["serviceId"],
    where: { isEligible: true },
  });
  console.log("BEFORE rematchAll:");
  console.log(`  Services total: ${services}`);
  console.log(`  Services with ≥1 eligible candidacy: ${matched.length}`);
  console.log(`  Out-of-scope services: ${services - matched.length}`);
  console.log(`  Per-product eligible counts:`);
  for (const slug of Object.keys(out).sort()) {
    console.log(`    ${slug.padEnd(20)} eligible=${out[slug].eligible}  ineligible=${out[slug].ineligible}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
