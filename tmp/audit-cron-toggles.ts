import { readFileSync } from "fs";
import { execSync } from "child_process";

const cronPaths = [
  "/api/cron/sync-services",
  "/api/cron/daily-retest",
  "/api/cron/test-bot",
  "/api/cron/scraper",
  "/api/cron/testbot-poll",
  "/api/cron/scoring",
  "/api/cron/pool-orchestrator",
  "/api/cron/pool-scrape-runner",
  "/api/cron/pool-health-check-runner",
  "/api/cron/pool-engagement-extract-runner",
  "/api/cron/pool-engagement-fill-runner",
  "/api/cron/pool-health-check",
  "/api/cron/pool-seeds-health-check",
  "/api/cron/pool-posts-health-check",
  "/api/cron/pool-cleanup",
  "/api/cron/suggestions-refill",
  "/api/cron/rapidapi-keys-reset",
  "/api/cron/workflow-executor",
  "/api/cron/alerts-detector",
  "/api/cron/scoring-campaign-runner",
  "/api/cron/brute-campaign-runner",
  "/api/cron/pool-cleanup-coordinator",
  "/api/cron/catalogue-health-check",
];

console.log("Cron route audit — toggle checks + auth checks:\n");
for (const p of cronPaths) {
  const filePath = `src/app${p}/route.ts`;
  let content = "";
  try { content = readFileSync(filePath, "utf8"); } catch { console.log(`  ${p} : MISSING FILE`); continue; }
  const hasCronAuth = content.includes("verifyCronAuth");
  const togglesUsed: string[] = [];
  for (const t of ["testBotEnabled", "scoringEngineEnabled", "dailyRetestEnabled", "dailySyncEnabled", "poolScrapeEnabled", "poolHealthcheckEnabled", "routingApiEnabled", "workflowExecutorEnabled", "autoKillDeadServicesEnabled", "dryRunMode"]) {
    if (content.includes(t)) togglesUsed.push(t);
  }
  const maxDur = content.match(/maxDuration\s*=\s*(\d+)/)?.[1] ?? "?";
  console.log(`  ${p}`);
  console.log(`    auth: ${hasCronAuth ? "✓ verifyCronAuth" : "✗ NO AUTH"}  maxDur: ${maxDur}s  toggles: [${togglesUsed.join(", ") || "none"}]`);
}
