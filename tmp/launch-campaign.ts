import { launchCampaign } from "../src/lib/scoring/campaign";

async function main() {
  const result = await launchCampaign({ maxCostPerTestUsd: 5 });
  console.log(JSON.stringify(result, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
