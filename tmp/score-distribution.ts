import { prisma } from "../src/lib/prisma";

async function main() {
  // Latest ServiceScore per service, RULE-1 valid (sampleCount > 0)
  const latest = await prisma.serviceScore.findMany({
    where: { sampleCount: { gt: 0 } },
    distinct: ["serviceId"],
    orderBy: [{ serviceId: "asc" }, { computedAt: "desc" }],
    select: {
      serviceId: true,
      currentScore: true,
      rawScore: true,
      weightedScore: true,
      sampleCount: true,
      completionFactor: true,
      speedScore: true,
      dropScore: true,
      avgTimeToFiftyMin: true,
      avgDropPct: true,
    },
  });
  console.log(`Total scored services: ${latest.length}`);

  // Distribution rawScore (independent of Bayesian)
  console.log(`\n=== Distribution rawScore (avant smoothing) ===`);
  const rawBuckets = { "0-9":0, "10-19":0, "20-29":0, "30-39":0, "40-49":0, "50-59":0, "60-69":0, "70-79":0, "80-89":0, "90-99":0, "100":0 };
  for (const s of latest) {
    const r = s.rawScore;
    if (r >= 100) rawBuckets["100"]++;
    else if (r >= 90) rawBuckets["90-99"]++;
    else if (r >= 80) rawBuckets["80-89"]++;
    else if (r >= 70) rawBuckets["70-79"]++;
    else if (r >= 60) rawBuckets["60-69"]++;
    else if (r >= 50) rawBuckets["50-59"]++;
    else if (r >= 40) rawBuckets["40-49"]++;
    else if (r >= 30) rawBuckets["30-39"]++;
    else if (r >= 20) rawBuckets["20-29"]++;
    else if (r >= 10) rawBuckets["10-19"]++;
    else rawBuckets["0-9"]++;
  }
  for (const [k, v] of Object.entries(rawBuckets)) {
    const bar = "█".repeat(Math.min(50, Math.round(v / 10)));
    console.log(`  ${k.padEnd(8)} ${v.toString().padStart(4)} ${bar}`);
  }

  // Distribution weightedScore (after Bayesian)
  console.log(`\n=== Distribution weightedScore (after Bayesian smoothing) ===`);
  const wBuckets = { "0-9":0, "10-19":0, "20-29":0, "30-39":0, "40-49":0, "50-59":0, "60-69":0, "70-79":0, "80-89":0, "90-99":0, "100":0 };
  for (const s of latest) {
    const r = s.weightedScore;
    if (r >= 100) wBuckets["100"]++;
    else if (r >= 90) wBuckets["90-99"]++;
    else if (r >= 80) wBuckets["80-89"]++;
    else if (r >= 70) wBuckets["70-79"]++;
    else if (r >= 60) wBuckets["60-69"]++;
    else if (r >= 50) wBuckets["50-59"]++;
    else if (r >= 40) wBuckets["40-49"]++;
    else if (r >= 30) wBuckets["30-39"]++;
    else if (r >= 20) wBuckets["20-29"]++;
    else if (r >= 10) wBuckets["10-19"]++;
    else wBuckets["0-9"]++;
  }
  for (const [k, v] of Object.entries(wBuckets)) {
    const bar = "█".repeat(Math.min(50, Math.round(v / 10)));
    console.log(`  ${k.padEnd(8)} ${v.toString().padStart(4)} ${bar}`);
  }

  // Distribution sub-scores (completion / speed / drop)
  console.log(`\n=== Distribution sub-scores ===`);
  const completion = latest.map((s) => s.completionFactor);
  const speed = latest.map((s) => s.speedScore);
  const drop = latest.map((s) => s.dropScore);
  const stats = (arr: number[]) => ({
    min: Math.min(...arr).toFixed(1),
    p25: arr.sort((a, b) => a - b)[Math.floor(arr.length * 0.25)]?.toFixed(1) ?? "?",
    p50: arr.sort((a, b) => a - b)[Math.floor(arr.length * 0.50)]?.toFixed(1) ?? "?",
    p75: arr.sort((a, b) => a - b)[Math.floor(arr.length * 0.75)]?.toFixed(1) ?? "?",
    max: Math.max(...arr).toFixed(1),
    avg: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1),
  });
  console.log(`  completionFactor : ${JSON.stringify(stats([...completion]))}`);
  console.log(`  speedScore       : ${JSON.stringify(stats([...speed]))}`);
  console.log(`  dropScore        : ${JSON.stringify(stats([...drop]))}`);

  // avgTimeToFiftyMin distribution
  const t50 = latest.map((s) => s.avgTimeToFiftyMin).filter((v): v is number => v !== null);
  console.log(`\n  timeToFiftyMin (n=${t50.length}, ${latest.length - t50.length} null):`);
  if (t50.length > 0) console.log(`    ${JSON.stringify(stats([...t50]))}`);

  // avgDropPct
  const dPct = latest.map((s) => s.avgDropPct).filter((v): v is number => v !== null);
  console.log(`  avgDropPct (n=${dPct.length}):`);
  if (dPct.length > 0) console.log(`    ${JSON.stringify(stats([...dPct]))}`);

  // Sample 10 services with DIFFERENT raw scores to see what makes them different
  console.log(`\n=== Sample 10 services par raw score (variety check) ===`);
  const sortedBySpread = [...latest].sort((a, b) => a.rawScore - b.rawScore);
  const picks = [
    sortedBySpread[0],
    sortedBySpread[Math.floor(sortedBySpread.length * 0.1)],
    sortedBySpread[Math.floor(sortedBySpread.length * 0.25)],
    sortedBySpread[Math.floor(sortedBySpread.length * 0.50)],
    sortedBySpread[Math.floor(sortedBySpread.length * 0.75)],
    sortedBySpread[Math.floor(sortedBySpread.length * 0.90)],
    sortedBySpread[sortedBySpread.length - 1],
  ];
  for (const s of picks) {
    if (!s) continue;
    console.log(
      `  svc#${s.serviceId} raw=${s.rawScore.toFixed(1)} weighted=${s.weightedScore.toFixed(1)} n=${s.sampleCount} | comp=${s.completionFactor.toFixed(1)} speed=${s.speedScore.toFixed(1)} drop=${s.dropScore.toFixed(1)} t50=${s.avgTimeToFiftyMin?.toFixed(0) ?? "?"}min dropPct=${s.avgDropPct?.toFixed(1) ?? "?"}%`
    );
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
