import { backfillLifecycle } from "../src/lib/catalogue/lifecycle";

async function main() {
  console.log("Running backfillLifecycle on prod DB...");
  const r = await backfillLifecycle();
  console.log(JSON.stringify(r, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
