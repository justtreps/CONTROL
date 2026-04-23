// Unified "fill the engagement pool" orchestrator. The operator just
// says "grow the engagement pool by N posts" and the system picks the
// cheapest path automatically:
//
//   Phase 1 — exploit the existing follower pool via engagement-extract
//             (1 RapidAPI call per account → N posts added if they
//              pass the freshness + likes filters).
//   Phase 2 — only reached if phase 1 exhausts the eligible followers
//             WITHOUT reaching target. Falls back to seed-scraping
//             new candidates via runScrapeTranche with
//             stats.poolType = "engagement" (2 calls per candidate).
//
// Both phases checkpoint into the same FillStats JSON on PoolJob so
// a killed function resumes cleanly on the next runner tick, no
// double-processing of any seed / account.

import {
  runEngagementExtractTranche,
  initExtractStats,
  type ExtractStats,
} from "./engagement-extract";
import {
  runScrapeTranche,
  initScrapeStats,
  type ScrapeStats,
} from "./scraper";

export type FillStats = {
  target: number;
  platform: "instagram" | "tiktok" | "both";
  startedAt: string;
  phase: "extract" | "scrape" | "done";
  addedViaExtract: number;
  addedViaScrape: number;
  totalAdded: number;
  extract: ExtractStats;
  scrape?: ScrapeStats;
  // Stamped on the stats so PoolActiveJobs / PoolJobsHistory can show
  // a · ENGAGEMENT suffix on the job label.
  poolType: "engagement";
};

export function initFillStats(
  platform: "instagram" | "tiktok" | "both",
  target: number
): FillStats {
  return {
    target,
    platform,
    startedAt: new Date().toISOString(),
    phase: "extract",
    addedViaExtract: 0,
    addedViaScrape: 0,
    totalAdded: 0,
    extract: initExtractStats(platform, target),
    poolType: "engagement",
  };
}

export async function runEngagementFillTranche({
  stats,
  budgetMs,
  stopRequested,
}: {
  stats: FillStats;
  budgetMs: number;
  stopRequested: () => Promise<boolean>;
}): Promise<{ done: boolean; stats: FillStats }> {
  const deadline = Date.now() + budgetMs;

  // ── Phase 1: extract ──────────────────────────────────────────────
  if (stats.phase === "extract") {
    const subBudget = Math.max(0, deadline - Date.now());
    const { done: extractDone } = await runEngagementExtractTranche({
      stats: stats.extract,
      budgetMs: subBudget,
      stopRequested,
    });
    stats.addedViaExtract = stats.extract.addedPosts;
    stats.totalAdded = stats.addedViaExtract + stats.addedViaScrape;

    if (stats.totalAdded >= stats.target) {
      stats.phase = "done";
      return { done: true, stats };
    }
    if (!extractDone) {
      // Extract still has eligible accounts to try — don't skip to
      // phase 2 prematurely. Checkpoint and let the next tick resume.
      return { done: false, stats };
    }

    // Extract exhausted AND target not reached → transition to scrape
    stats.phase = "scrape";
    const remaining = Math.max(1, stats.target - stats.totalAdded);
    stats.scrape = initScrapeStats(stats.platform, remaining);
    stats.scrape.poolType = "engagement";
  }

  if (Date.now() >= deadline) return { done: false, stats };

  // ── Phase 2: scrape seeds ─────────────────────────────────────────
  if (stats.phase === "scrape" && stats.scrape) {
    const subBudget = Math.max(0, deadline - Date.now());
    const { done: scrapeDone } = await runScrapeTranche({
      stats: stats.scrape,
      budgetMs: subBudget,
      stopRequested,
    });
    stats.addedViaScrape = stats.scrape.addedA + stats.scrape.addedB;
    stats.totalAdded = stats.addedViaExtract + stats.addedViaScrape;

    if (stats.totalAdded >= stats.target || scrapeDone) {
      stats.phase = "done";
      return { done: true, stats };
    }
    return { done: false, stats };
  }

  return { done: true, stats };
}
