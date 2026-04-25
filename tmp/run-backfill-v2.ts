import { backfillLifecycle, lifecycleCounts } from "../src/lib/catalogue/lifecycle";

async function main() {
  console.log("=== BEFORE ===");
  console.log(JSON.stringify(await lifecycleCounts(), null, 2));

  console.log("\n=== Running backfill ===");
  const r = await backfillLifecycle();
  console.log(JSON.stringify(r, null, 2));

  console.log("\n=== AFTER ===");
  console.log(JSON.stringify(await lifecycleCounts(), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
