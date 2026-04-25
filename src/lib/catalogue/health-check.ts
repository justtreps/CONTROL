// Daily catalogue health check.
//
// One pass each night (03:00 UTC) that:
//   A. Fetches the BulkMedya catalogue
//   B. Detects new services + creates Service rows + matches them
//      against MyBoost products → ProductServiceCandidate=NEW
//   C. Detects services BulkMedya stopped returning → flips
//      Service.active=false + lifecycleStatus=REMOVED_FROM_BULKMEDYA
//   D. Tries to revive PLACEMENT_FAILED services with one safe
//      placement; after 3 consecutive revive failures the service
//      lands in PERMANENTLY_FAILED (out of the routable pool for
//      good unless an operator revives by hand)
//   E. Runs rematchAll to reconcile classifications
//   F. Writes a CatalogueSyncRun row + emits info / warning alerts
//
// The runner is idempotent — a second invocation of an already-
// running run aborts cleanly. The cron endpoint serializes via
// CatalogueSyncRun.status='running' lock.

import { prisma } from "@/lib/prisma";
import { fetchServices, classifyServiceType, placeOrder } from "@/lib/bulkmedya";
import { rematchAll } from "./matcher";
import { detectCountry } from "@/lib/services/classifier";

const REVIVE_BATCH_CAP = 200; // BulkMedya orders per run
const REVIVE_CONCURRENCY = 25;
const PERMANENT_FAIL_AFTER = 3;
// Per-service cost cap for auto-placement of NEW services.
// Mega-min ADS SKUs ($350+) are skipped here, same logic as the
// campaign runners.
const AUTO_PLACE_MAX_COST_USD = 5;

export type HealthCheckSummary = {
  runId: number;
  bulkmedyaTotal: number;
  added: number;
  removed: number;
  revived: number;
  permanentlyFailed: number;
  reviveAttempted: number;
  reviveStillFailed: number;
  rematchUpdated: number;
  rematchOutOfScope: number;
  perProduct: Record<string, number>;
  // Phase F — auto-place NEW services via brute-mode campaign.
  // The actual BulkMedya orders are handled by /api/cron/brute-
  // campaign-runner so we don't blow the 300s health-check budget.
  autoPlace: {
    queuedCount: number;
    skippedExpensive: number;
    estimatedCostUsd: number;
    campaignId: number | null;
    mode: "new_campaign" | "merged_into_existing" | "no_op";
  };
  durationMs: number;
};

// ── Entry point ────────────────────────────────────────────────

export async function runCatalogueHealthCheck(): Promise<HealthCheckSummary> {
  const run = await prisma.catalogueSyncRun.create({
    data: { status: "running" },
  });
  const startedAt = Date.now();

  try {
    // A. Fetch BulkMedya
    const raw = await fetchServices();
    if (!Array.isArray(raw)) {
      throw new Error(
        `Unexpected services response: ${JSON.stringify(raw).slice(0, 200)}`
      );
    }
    const bulkmedyaIdsReturned = new Set<number>();
    for (const r of raw) {
      const id = Number(r.service);
      if (Number.isFinite(id)) bulkmedyaIdsReturned.add(id);
    }

    // B. Detect new services. Existing Service rows by bulkmedyaId.
    const existing = await prisma.service.findMany({
      select: { id: true, bulkmedyaId: true, active: true },
    });
    const existingIds = new Set(existing.map((s) => s.bulkmedyaId));
    let added = 0;
    for (const r of raw) {
      const bid = Number(r.service);
      if (!Number.isFinite(bid) || existingIds.has(bid)) continue;

      const platform = inferPlatform(String(r.category ?? r.name ?? ""), String(r.name ?? ""));
      if (!platform) continue;
      const serviceType = classifyServiceType(String(r.name ?? ""), String(r.category ?? ""));
      if (serviceType === "disabled") continue;
      const minQuantity = Math.max(1, Number(r.min ?? 0) || 0);
      const maxQuantity = Math.max(minQuantity, Number(r.max ?? minQuantity) || minQuantity);
      const ratePerK = Number(r.rate ?? 0) || 0;
      const targetCountry = detectCountry(String(r.name ?? ""));

      try {
        await prisma.service.create({
          data: {
            bulkmedyaId: bid,
            name: String(r.name ?? ""),
            category: String(r.category ?? ""),
            platform,
            serviceType,
            ratePerK,
            minQuantity,
            maxQuantity,
            refillSupported: Boolean(r.refill),
            cancelSupported: Boolean(r.cancel),
            active: true,
            targetCountry,
          },
        });
        added++;
      } catch {
        // Race: another writer just inserted the same bulkmedyaId.
        // Skip silently.
      }
    }

    // C. Detect services BulkMedya removed.
    let removed = 0;
    for (const s of existing) {
      if (bulkmedyaIdsReturned.has(s.bulkmedyaId)) continue;
      // Already marked removed?
      const cur = await prisma.service.findUnique({
        where: { id: s.id },
        select: { removedFromProviderAt: true },
      });
      if (cur?.removedFromProviderAt) continue;
      await prisma.service.update({
        where: { id: s.id },
        data: {
          active: false,
          removedFromProviderAt: new Date(),
        },
      });
      await prisma.productServiceCandidate.updateMany({
        where: { serviceId: s.id },
        data: {
          lifecycleStatus: "REMOVED_FROM_BULKMEDYA",
          isEligible: false,
        },
      });
      removed++;
    }
    if (removed > 0) {
      await emitServiceRemovedAlert(removed);
    }

    // D. Revive PLACEMENT_FAILED. One attempt per service per
    //    health-check run. After PERMANENT_FAIL_AFTER total
    //    failures, mark PERMANENTLY_FAILED.
    const revivePool = await prisma.productServiceCandidate.findMany({
      where: { lifecycleStatus: "PLACEMENT_FAILED" },
      include: {
        service: { select: { id: true, placementAttemptCount: true, active: true } },
      },
      take: REVIVE_BATCH_CAP * 4, // pull extra for de-dup
    });
    const seenForRevive = new Set<number>();
    const reviveQueue: Array<{ serviceId: number; attempt: number }> = [];
    for (const c of revivePool) {
      if (!c.service || !c.service.active) continue;
      if (seenForRevive.has(c.service.id)) continue;
      seenForRevive.add(c.service.id);
      reviveQueue.push({
        serviceId: c.service.id,
        attempt: c.service.placementAttemptCount,
      });
      if (reviveQueue.length >= REVIVE_BATCH_CAP) break;
    }

    let revived = 0;
    let permanentlyFailed = 0;
    let reviveStillFailed = 0;
    for (let i = 0; i < reviveQueue.length; i += REVIVE_CONCURRENCY) {
      const wave = reviveQueue.slice(i, i + REVIVE_CONCURRENCY);
      await Promise.all(
        wave.map(async (entry) => {
          const ok = await tryReviveOne(entry.serviceId);
          if (ok) {
            await prisma.productServiceCandidate.updateMany({
              where: {
                serviceId: entry.serviceId,
                lifecycleStatus: "PLACEMENT_FAILED",
              },
              data: { lifecycleStatus: "NEW", isEligible: true },
            });
            await prisma.service.update({
              where: { id: entry.serviceId },
              data: { placementAttemptCount: 0 },
            });
            revived++;
            return;
          }
          const newCount = entry.attempt + 1;
          if (newCount >= PERMANENT_FAIL_AFTER) {
            await prisma.productServiceCandidate.updateMany({
              where: { serviceId: entry.serviceId },
              data: {
                lifecycleStatus: "PERMANENTLY_FAILED",
                isEligible: false,
              },
            });
            await prisma.service.update({
              where: { id: entry.serviceId },
              data: { placementAttemptCount: newCount, active: false },
            });
            permanentlyFailed++;
          } else {
            await prisma.service.update({
              where: { id: entry.serviceId },
              data: { placementAttemptCount: newCount },
            });
            reviveStillFailed++;
          }
        })
      );
    }

    // E. Reclassify everything via matcher. Picks up the newly
    //    added rows + flags any services that drifted product
    //    matches.
    const rematch = await rematchAll();

    // F. Auto-place every NEW eligible service. We don't run the
    //    BulkMedya orders inline (would blow the 300s budget on
    //    1000+ services) — instead we hand them off to the brute-
    //    campaign-runner cron which fires every minute. If a
    //    brute campaign is already running, we merge our IDs into
    //    its targetServiceIds so it drains both at once.
    const newCands = await prisma.productServiceCandidate.findMany({
      where: {
        lifecycleStatus: "NEW",
        isEligible: true,
        forceExcluded: false,
        service: { active: true },
      },
      include: {
        service: { select: { id: true, ratePerK: true, minQuantity: true } },
      },
    });
    const seenForPlace = new Set<number>();
    const placeable: number[] = [];
    let placeCost = 0;
    let skippedExpensive = 0;
    for (const c of newCands) {
      if (!c.service || seenForPlace.has(c.serviceId)) continue;
      seenForPlace.add(c.serviceId);
      const cost = (c.service.ratePerK * c.service.minQuantity) / 1000;
      if (cost > AUTO_PLACE_MAX_COST_USD) {
        skippedExpensive++;
        continue;
      }
      placeable.push(c.serviceId);
      placeCost += cost;
    }

    let autoPlaceMode: "new_campaign" | "merged_into_existing" | "no_op" = "no_op";
    let autoPlaceCampaignId: number | null = null;

    if (placeable.length > 0) {
      const activeBrute = await prisma.scoringCampaign.findFirst({
        where: { status: "running", stopReason: "brute_mode" },
        orderBy: { id: "desc" },
      });
      if (activeBrute) {
        // Merge the new IDs into the existing campaign so the
        // runner picks them up on its next tick. Dedup against
        // already-placed services so we don't double-fire.
        const placedSet = new Set(activeBrute.placedServiceIds);
        const merged = Array.from(
          new Set([
            ...activeBrute.targetServiceIds,
            ...placeable.filter((id) => !placedSet.has(id)),
          ])
        );
        await prisma.scoringCampaign.update({
          where: { id: activeBrute.id },
          data: {
            targetServiceIds: merged,
            estimatedCostUsd:
              (activeBrute.estimatedCostUsd ?? 0) +
              Math.round(placeCost * 100) / 100,
          },
        });
        autoPlaceCampaignId = activeBrute.id;
        autoPlaceMode = "merged_into_existing";
      } else {
        const created = await prisma.scoringCampaign.create({
          data: {
            status: "running",
            stopReason: "brute_mode",
            targetServiceIds: placeable,
            estimatedCostUsd: Math.round(placeCost * 100) / 100,
          },
        });
        autoPlaceCampaignId = created.id;
        autoPlaceMode = "new_campaign";

        // Fire-and-forget the first tick so placements start
        // before the next minute-cron firing.
        const origin = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
        const secret = process.env.CRON_SECRET ?? "";
        void fetch(`${origin}/api/cron/brute-campaign-runner`, {
          method: "POST",
          headers: { Authorization: `Bearer ${secret}` },
        }).catch(() => null);
      }
    }

    // G. Emit alerts + persist run.
    const summary: HealthCheckSummary = {
      runId: run.id,
      bulkmedyaTotal: bulkmedyaIdsReturned.size,
      added,
      removed,
      revived,
      permanentlyFailed,
      reviveAttempted: reviveQueue.length,
      reviveStillFailed,
      rematchUpdated: rematch.candidatesUpdated,
      rematchOutOfScope: rematch.servicesOutOfScope,
      perProduct: Object.fromEntries(
        Object.entries(rematch.perProduct).map(([slug, b]) => [slug, b.eligible])
      ),
      autoPlace: {
        queuedCount: placeable.length,
        skippedExpensive,
        estimatedCostUsd: Math.round(placeCost * 100) / 100,
        campaignId: autoPlaceCampaignId,
        mode: autoPlaceMode,
      },
      durationMs: Date.now() - startedAt,
    };

    await prisma.catalogueSyncRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        finishedAt: new Date(),
        bulkmedyaTotal: summary.bulkmedyaTotal,
        addedCount: summary.added,
        removedCount: summary.removed,
        revivedCount: summary.revived,
        permanentlyFailedCount: summary.permanentlyFailed,
        rematchUpdatedCount: summary.rematchUpdated,
        rematchOutOfScope: summary.rematchOutOfScope,
        summary: summary as unknown as object,
      },
    });

    await emitHealthCheckDoneAlert(summary);
    if (added > 0) await emitNewServicesAlert(added);

    return summary;
  } catch (e) {
    const message = (e as Error).message.slice(0, 1000);
    await prisma.catalogueSyncRun.update({
      where: { id: run.id },
      data: {
        status: "error",
        finishedAt: new Date(),
        errorMessage: message,
      },
    }).catch(() => null);
    await emitHealthCheckFailedAlert(message);
    throw e;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function inferPlatform(category: string, name: string): string | null {
  const s = `${category} ${name}`.toLowerCase();
  if (s.includes("instagram") || s.includes("ig ")) return "instagram";
  if (s.includes("tiktok") || s.includes("tt ")) return "tiktok";
  if (s.includes("youtube") || s.includes("yt ")) return "youtube";
  if (s.includes("facebook") || s.includes("fb ")) return "facebook";
  if (s.includes("twitter") || s.includes("x.com")) return "twitter";
  return null;
}

// One safe placement attempt against PLACEMENT_FAILED. Picks the
// FIRST available pool entity, fires placeOrder once, returns
// true on success false on any failure. Doesn't write a TestOrder
// — this is a probe, not a real test. The service will be re-tested
// via the next campaign or daily-retest if it's revived.
//
// Pool entities are RELEASED back to available regardless of
// outcome — the probe doesn't consume them.
async function tryReviveOne(serviceId: number): Promise<boolean> {
  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: {
      id: true,
      platform: true,
      bulkmedyaId: true,
      minQuantity: true,
      poolType: true,
    },
  });
  if (!service) return false;

  const isEngagement = service.poolType === "engagement_test";

  let bulkLink = "";
  let releasePost: number | null = null;
  let releaseAccount: number | null = null;

  if (isEngagement) {
    const post = await prisma.testPost.findFirst({
      where: { status: "available", platform: service.platform },
      include: { testAccount: true },
      orderBy: { firstSeenAt: "asc" },
    });
    if (!post) return false;
    bulkLink = post.mediaUrl;
    releasePost = post.id;
  } else {
    const account = await prisma.testAccount.findFirst({
      where: {
        status: "available",
        platform: service.platform,
        accountType: "follower_test",
      },
      orderBy: { firstSeenAt: "asc" },
    });
    if (!account) return false;
    bulkLink =
      service.platform === "instagram"
        ? `https://www.instagram.com/${account.username}/`
        : `https://www.tiktok.com/@${account.username}`;
    releaseAccount = account.id;
  }

  try {
    const order = await placeOrder({
      service: service.bulkmedyaId,
      link: bulkLink,
      quantity: service.minQuantity,
    });
    return !("error" in order);
  } catch {
    return false;
  } finally {
    // Probe doesn't consume pool entities.
    if (releasePost) {
      await prisma.testPost
        .update({
          where: { id: releasePost },
          data: { status: "available" },
        })
        .catch(() => null);
    }
    if (releaseAccount) {
      await prisma.testAccount
        .update({
          where: { id: releaseAccount },
          data: { status: "available", active: true },
        })
        .catch(() => null);
    }
  }
}

// ── Alerts (best-effort writes — match the lifecycle.ts pattern) ─

async function emitNewServicesAlert(count: number): Promise<void> {
  try {
    const existing = await prisma.alert.findFirst({
      where: {
        code: "catalogue_new_services",
        status: { in: ["active", "acknowledged"] },
      },
    });
    const title = `${count} nouveaux services ajoutés au catalogue`;
    const description = `Sync BulkMedya du ${new Date()
      .toISOString()
      .slice(0, 16)} → ${count} services inédits.`;
    if (existing) {
      await prisma.alert.update({
        where: { id: existing.id },
        data: {
          title,
          description,
          lastTriggeredAt: new Date(),
          triggerCount: { increment: 1 },
          status: "active",
        },
      });
    } else {
      await prisma.alert.create({
        data: {
          code: "catalogue_new_services",
          category: "catalogue",
          severity: "info",
          title,
          description,
          explanation:
            "Les nouveaux services passent par le matcher et se retrouvent dans l'état lifecycleStatus=NEW. Ils seront testés à la prochaine campagne ou via le daily-retest.",
          impact:
            "Aucun — les nouveaux services n'impactent pas le routage tant qu'ils ne sont pas QUALIFIED.",
          suggestedAction:
            "Ouvrir /config/catalogue pour voir les nouveaux services par produit.",
          actionType: "link",
          actionPayload: { href: "/config/catalogue" },
          status: "active",
          firstTriggeredAt: new Date(),
          lastTriggeredAt: new Date(),
          triggerCount: 1,
        },
      });
    }
  } catch {
    /* best-effort */
  }
}

async function emitServiceRemovedAlert(count: number): Promise<void> {
  try {
    await prisma.alert.create({
      data: {
        code: `service_removed_provider:${Date.now()}`,
        category: "catalogue",
        severity: "warning",
        title: `${count} service(s) supprimé(s) côté BulkMedya`,
        description: `BulkMedya ne retourne plus ces bulkmedyaId. Marqués REMOVED_FROM_BULKMEDYA + isEligible=false.`,
        explanation:
          "Le sync quotidien compare la liste BulkMedya au catalogue local. Les services absents ont été supprimés ou désactivés côté provider. Le routage les écarte automatiquement; si le provider les remet en ligne le prochain sync les remarque dispo.",
        impact:
          "Le routage ne propose plus ces services. Si c'étaient les seuls QUALIFIED d'un produit MyBoost, le détecteur product_qualified_services_low s'allume.",
        suggestedAction:
          "Ouvrir /config/catalogue, filtrer sur lifecycleStatus=REMOVED_FROM_BULKMEDYA pour voir la liste.",
        actionType: "link",
        actionPayload: { href: "/config/catalogue" },
        status: "active",
        firstTriggeredAt: new Date(),
        lastTriggeredAt: new Date(),
        triggerCount: 1,
      },
    });
  } catch {
    /* best-effort */
  }
}

async function emitHealthCheckDoneAlert(s: HealthCheckSummary): Promise<void> {
  try {
    await prisma.alert.create({
      data: {
        code: `catalogue_health_check_done:${s.runId}`,
        category: "catalogue",
        severity: "info",
        title: `Sync catalogue OK — +${s.added} / −${s.removed} / ↻${s.revived}`,
        description: `BulkMedya total ${s.bulkmedyaTotal} · ajoutés ${s.added} · supprimés ${s.removed} · revive OK ${s.revived} · still failed ${s.reviveStillFailed} · permanently failed ${s.permanentlyFailed} · rematch updated ${s.rematchUpdated} · out-of-scope ${s.rematchOutOfScope} · ${(s.durationMs / 1000).toFixed(1)}s`,
        explanation:
          "Health check journalier (03:00 UTC) — fetch BulkMedya, détecte new/removed, tente revive PLACEMENT_FAILED (1 placement par service, 3 fails consécutifs → PERMANENTLY_FAILED), reclassifie via matcher.",
        impact: "Catalogue à jour pour les 24h suivantes.",
        suggestedAction: "Aucune action requise — info auto-resolved au prochain run.",
        actionType: "link",
        actionPayload: { href: "/config/catalogue" },
        status: "active",
        firstTriggeredAt: new Date(),
        lastTriggeredAt: new Date(),
        triggerCount: 1,
      },
    });
  } catch {
    /* best-effort */
  }
}

async function emitHealthCheckFailedAlert(message: string): Promise<void> {
  try {
    await prisma.alert.create({
      data: {
        code: `catalogue_health_check_failed:${Date.now()}`,
        category: "catalogue",
        severity: "critical",
        title: "Sync catalogue ÉCHOUÉ",
        description: message.slice(0, 300),
        explanation:
          "Le health-check journalier a crashé avant complétion. CatalogueSyncRun row contient le détail. Causes typiques : BulkMedya API down, clé invalidée, schéma DB drift.",
        impact:
          "Le catalogue n'est pas à jour. Nouveaux services BulkMedya invisibles, services morts pas marqués, PLACEMENT_FAILED pas re-essayés.",
        suggestedAction:
          "Vérifier les logs Vercel sur /api/cron/catalogue-health-check + retrigger manuellement via le dashboard si la cause est résolue.",
        actionType: "link",
        actionPayload: { href: "/" },
        status: "active",
        firstTriggeredAt: new Date(),
        lastTriggeredAt: new Date(),
        triggerCount: 1,
      },
    });
  } catch {
    /* best-effort */
  }
}

// Returns the most recent CatalogueSyncRun + 30-day rollups for
// the dashboard SyncHealthCard.
export async function getCatalogueSyncStatus() {
  const last = await prisma.catalogueSyncRun.findFirst({
    orderBy: { startedAt: "desc" },
  });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const monthAgg = await prisma.catalogueSyncRun.aggregate({
    where: { startedAt: { gte: since } },
    _sum: {
      addedCount: true,
      removedCount: true,
      revivedCount: true,
      permanentlyFailedCount: true,
    },
  });
  return {
    last: last
      ? {
          id: last.id,
          startedAt: last.startedAt.toISOString(),
          finishedAt: last.finishedAt ? last.finishedAt.toISOString() : null,
          status: last.status,
          errorMessage: last.errorMessage ?? null,
          added: last.addedCount,
          removed: last.removedCount,
          revived: last.revivedCount,
          permanentlyFailed: last.permanentlyFailedCount,
          bulkmedyaTotal: last.bulkmedyaTotal,
        }
      : null,
    last30d: {
      added: monthAgg._sum.addedCount ?? 0,
      removed: monthAgg._sum.removedCount ?? 0,
      revived: monthAgg._sum.revivedCount ?? 0,
      permanentlyFailed: monthAgg._sum.permanentlyFailedCount ?? 0,
    },
  };
}
