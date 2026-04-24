// Alert detectors — each returns 0..N DetectorResult rows on every
// 2-min tick. Stateless by design: the engine handles
// create/update/resolve based on the absence/presence of each code
// in the current tick's result set.
//
// Tier 1 detectors (DB-only, no external API calls) shipped first.
// Detectors that need Vercel log scraping / Bulkmedya balance API /
// Supabase query timing are deferred — see infra-deferred notes at
// the bottom of this file.

import { prisma } from "@/lib/prisma";
import { getPoolConfig } from "@/lib/pool/config";
import { ig429SnapshotForDebug } from "@/lib/rapidapi/rate-limit";
import type { Detector, DetectorResult } from "./types";

// ── Helpers ────────────────────────────────────────────────────

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600 * 1000);
}
function minutesAgo(m: number): Date {
  return new Date(Date.now() - m * 60 * 1000);
}
function pct(num: number, denom: number): number {
  return denom > 0 ? Math.round((num / denom) * 1000) / 10 : 0;
}

// ── RAPIDAPI ───────────────────────────────────────────────────

// key_near_cap — quotaUsed ≥ 90% of quotaMonthly on any active key.
export const detectKeyNearCap: Detector = async () => {
  const keys = await prisma.rapidApiKey.findMany({
    where: { status: "active", quotaMonthly: { not: null } },
  });
  const out: DetectorResult[] = [];
  for (const k of keys) {
    if (!k.quotaMonthly) continue;
    const ratio = k.quotaUsed / k.quotaMonthly;
    if (ratio < 0.9) continue;
    const severity = ratio >= 0.98 ? "critical" : "warning";
    out.push({
      code: `key_near_cap:${k.id}`,
      category: "rapidapi",
      severity,
      title: `Clé RapidAPI #${k.id} proche du cap mensuel`,
      description: `"${k.label}" a consommé ${pct(k.quotaUsed, k.quotaMonthly)}% de son quota.`,
      explanation: `quotaUsed=${k.quotaUsed.toLocaleString("en-US")} / quotaMonthly=${k.quotaMonthly.toLocaleString("en-US")} = ${pct(k.quotaUsed, k.quotaMonthly)}%. Seuil d'alerte 90 %. Le reset mensuel est configuré pour le ${k.resetDayOfMonth ?? "?"} du mois.`,
      impact:
        "Si la clé atteint 100 %, les appels IG retourneront 429 quota-exceeded et le failover basculera sur la clé suivante. Si c'est la dernière active, tous les jobs IG se marqueront 'stuck:all_keys_capped' jusqu'au reset.",
      suggestedAction:
        "Ajouter une nouvelle clé backup depuis /config ou attendre le reset. Si tu as déjà 2+ clés actives, rien à faire — le failover est automatique.",
      actionType: "link",
      actionPayload: { href: "/config" },
      relatedEntityType: "rapidApiKey",
      relatedEntityId: k.id,
    });
  }
  return out;
};

// key_capped — status='capped' on any key.
export const detectKeyCapped: Detector = async () => {
  const keys = await prisma.rapidApiKey.findMany({ where: { status: "capped" } });
  return keys.map((k) => ({
    code: `key_capped:${k.id}`,
    category: "rapidapi",
    severity: "warning" as const,
    title: `Clé RapidAPI #${k.id} cappée`,
    description: `"${k.label}" est marquée capped depuis ${k.lastCappedAt?.toISOString() ?? "?"}.`,
    explanation: `Le manager a flaggé cette clé après un 429 quota-exceeded. Elle ne sera plus pickée en round-robin tant que /api/cron/rapidapi-keys-reset ne la réactive pas (reset jour ${k.resetDayOfMonth ?? "?"}).`,
    impact:
      "Diminution du throughput agrégé tant que la clé n'est pas réactivée — les autres clés actives absorbent la charge (chacune à son propre plafond rateLimitPerMin).",
    suggestedAction:
      "Attendre le reset mensuel automatique, ou ajouter temporairement une clé backup.",
    actionType: "link",
    actionPayload: { href: "/config" },
    relatedEntityType: "rapidApiKey",
    relatedEntityId: k.id,
  }));
};

// all_keys_capped — every active IG key is capped (critical).
export const detectAllKeysCapped: Detector = async () => {
  const total = await prisma.rapidApiKey.count({
    where: { provider: "instagram", status: { not: "disabled" } },
  });
  if (total === 0) return [];
  const active = await prisma.rapidApiKey.count({
    where: { provider: "instagram", status: "active" },
  });
  if (active > 0) return [];
  const capped = await prisma.rapidApiKey.count({
    where: { provider: "instagram", status: "capped" },
  });
  return [
    {
      code: "all_keys_capped:instagram",
      category: "rapidapi",
      severity: "critical",
      title: "Toutes les clés RapidAPI sont cappées",
      description: `${capped}/${total} clés IG sont cappées, 0 active.`,
      explanation:
        "Tous les workers IG (scrape, health-check, engagement, testbot) vont bloquer jusqu'au reset mensuel. Le router /api/order fallback côté MyBoost reste disponible pour les commandes.",
      impact:
        "Pool growth stoppé, pas de nouveaux tests testbot, scoring gelé jusqu'au reset.",
      suggestedAction:
        "Ajouter une nouvelle clé RapidAPI tout de suite depuis /config (section Flotte RapidAPI).",
      actionType: "link",
      actionPayload: { href: "/config" },
    },
  ];
};

// rate_limiter_saturated — inFlight ≥ 80% of max on any key window,
// observed NOW.
export const detectRateLimiterSaturated: Detector = async () => {
  let snap;
  try {
    snap = await ig429SnapshotForDebug();
  } catch {
    return [];
  }
  const out: DetectorResult[] = [];
  for (const p of snap.perKey) {
    if (p.max === 0) continue;
    const ratio = p.inFlight / p.max;
    if (ratio < 0.8) continue;
    out.push({
      code: `rate_limiter_saturated:${p.keyId}`,
      category: "rapidapi",
      severity: ratio >= 0.95 ? "critical" : "warning",
      title: `Rate-limiter saturé sur la clé #${p.keyId}`,
      description: `${p.inFlight}/${p.max} req dans la fenêtre glissante 60s.`,
      explanation: `La fenêtre per-key actuelle est à ${Math.round(ratio * 100)}% de son plafond rateLimitPerMin. Backend: ${snap.backend}. Au-dessus de 85 % les workers passent leur temps à attendre un slot → throughput effectif s'écroule.`,
      impact:
        "Les tranches s'étalent (plus de fenêtres 'gaspillées' à attendre le rate-limiter). Progression réelle en accounts/min baisse.",
      suggestedAction:
        "Ajouter une clé backup pour doubler le plafond agrégé, ou ralentir les workers (réduire la concurrence testbot / scrape parallèle).",
      actionType: "link",
      actionPayload: { href: "/config" },
    });
  }
  return out;
};

// ── POOL ───────────────────────────────────────────────────────

// pool_below_min — count < refillThreshold on any (platform, pool).
export const detectPoolBelowMin: Detector = async () => {
  const cfg = await getPoolConfig();
  const out: DetectorResult[] = [];
  for (const platform of ["instagram", "tiktok"] as const) {
    const threshold =
      platform === "instagram"
        ? cfg.refillThresholdInstagram
        : cfg.refillThresholdTiktok;
    if (!threshold || threshold <= 0) continue;
    const count = await prisma.testAccount.count({
      where: { platform, status: "available" },
    });
    if (count >= threshold) continue;
    const ratio = count / threshold;
    const severity = ratio < 0.3 ? "critical" : "warning";
    out.push({
      code: `pool_below_min:${platform}`,
      category: "pool",
      severity,
      title: `Pool ${platform.toUpperCase()} sous le seuil`,
      description: `${count} comptes disponibles, seuil configuré à ${threshold}.`,
      explanation: `L'auto-refill cron queue normalement un scrape quand ça dip, mais l'alerte reste active tant que le pool ne repasse pas au-dessus. Ratio actuel : ${pct(count, threshold)}%.`,
      impact:
        "Moins d'accounts dispos = testbot va commencer à réutiliser les mêmes ou skipper des services. Health-check va peut-être invalider encore plus = spirale.",
      suggestedAction: `Lancer un scrape manuel depuis /pool si l'auto-refill ne rattrape pas.`,
      actionType: "button",
      actionPayload: {
        endpoint: "/api/pool/scrape",
        method: "POST",
        body: { platform, count: Math.max(500, threshold * 2), poolType: "follower" },
        confirm: `Lancer un scrape de ${Math.max(500, threshold * 2)} comptes ${platform} ?`,
      },
    });
  }
  return out;
};

// pool_high_invalidation — >40% accounts invalidated on last 7 days.
export const detectPoolHighInvalidation: Detector = async () => {
  const since = hoursAgo(7 * 24);
  const [invalidated, total] = await Promise.all([
    prisma.testAccount.count({
      where: { invalidatedAt: { gte: since } },
    }),
    prisma.testAccount.count({
      where: { firstSeenAt: { gte: since } },
    }),
  ]);
  if (total < 10) return []; // too small a sample
  const ratio = invalidated / total;
  if (ratio < 0.4) return [];
  return [
    {
      code: "pool_high_invalidation",
      category: "pool",
      severity: ratio >= 0.6 ? "critical" : "warning",
      title: "Taux d'invalidation élevé",
      description: `${invalidated} comptes invalidés / ${total} nouveaux sur 7j = ${pct(invalidated, total)}%.`,
      explanation: `Ratio invalidations / nouveaux comptes ≥ 40 % est le signal qu'on scrape dans des seeds pourris ou que IG purge des comptes plus vite que d'habitude. Seuils : 40 % = warning, 60 % = critical.`,
      impact:
        "Tu payes du quota RapidAPI pour des comptes qui meurent tout de suite. Le pool se vide malgré le scraping actif.",
      suggestedAction:
        "Audit les seeds récents (pool → onglet seeds) et désactive ceux dont le rate d'invalidation enfant est anormal. Vérifier si IG a fait un purge sur une catégorie.",
      actionType: "link",
      actionPayload: { href: "/pool" },
    },
  ];
};

// seeds_exhausted — average candidate rejection rate > 90% on
// recent scrape jobs.
export const detectSeedsExhausted: Detector = async () => {
  const recent = await prisma.poolJob.findMany({
    where: {
      jobType: "scrape",
      status: { in: ["completed", "stuck", "running"] },
      startedAt: { gte: hoursAgo(24) },
    },
    select: { id: true, stats: true, startedAt: true },
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  let totalFetched = 0;
  let totalQualified = 0;
  for (const j of recent) {
    const s = (j.stats ?? {}) as Record<string, unknown>;
    const fetched = typeof s.candidatesFetched === "number" ? s.candidatesFetched : 0;
    const qual = typeof s.candidatesQualified === "number" ? s.candidatesQualified : 0;
    totalFetched += fetched;
    totalQualified += qual;
  }
  if (totalFetched < 500) return []; // too thin
  const qualifyRate = totalQualified / totalFetched;
  if (qualifyRate >= 0.1) return [];
  return [
    {
      code: "seeds_exhausted",
      category: "pool",
      severity: qualifyRate < 0.05 ? "critical" : "warning",
      title: "Seeds épuisées — rejection > 90%",
      description: `${pct(totalQualified, totalFetched)}% de candidates qualifient sur les ${recent.length} derniers scrapes.`,
      explanation: `Sur les 24 dernières heures, ${totalFetched.toLocaleString("en-US")} candidates fetchées → ${totalQualified.toLocaleString("en-US")} qualifiées (${pct(totalQualified, totalFetched)}%). Seuil alerte : < 10 % qualifying. Souvent = les seeds principaux ont été épuisés, les followers restants sont majoritairement ghosts/verified/too_many_followers.`,
      impact: "Scrape consomme beaucoup de quota RapidAPI pour très peu d'ajouts. Scrape de 1000 comptes peut prendre des heures.",
      suggestedAction: "Ajouter/rotater les seeds dans le pool (section Seeds). Cibler des influenceurs niche avec un audience encore non-scrapé.",
      actionType: "link",
      actionPayload: { href: "/pool" },
    },
  ];
};

// scrape_stale — scrape job running but no addedA growth > 2h.
export const detectScrapeStale: Detector = async () => {
  const jobs = await prisma.poolJob.findMany({
    where: {
      jobType: "scrape",
      status: "running",
      startedAt: { lt: hoursAgo(2) },
    },
  });
  const out: DetectorResult[] = [];
  for (const j of jobs) {
    const s = (j.stats ?? {}) as Record<string, unknown>;
    const added =
      (typeof s.addedA === "number" ? s.addedA : 0) +
      (typeof s.addedB === "number" ? s.addedB : 0);
    const lastProgressAt =
      typeof s.lastProgressAt === "string"
        ? new Date(s.lastProgressAt)
        : null;
    const ageMs = lastProgressAt
      ? Date.now() - lastProgressAt.getTime()
      : Date.now() - j.startedAt.getTime();
    if (ageMs < 2 * 3600 * 1000) continue;
    out.push({
      code: `scrape_stale:${j.id}`,
      category: "job",
      severity: "warning",
      title: `Scrape #${j.id} stale depuis >2h`,
      description: `${added} comptes ajoutés, aucune progression depuis ${Math.round(ageMs / 60_000)}min.`,
      explanation: `Job lancé à ${j.startedAt.toISOString()}. Dernière progression réelle : ${lastProgressAt?.toISOString() ?? "n/a (utilise startedAt fallback)"}. Le job continue à ticker (heartbeat) mais addedA ne monte plus.`,
      impact: "Le job occupe un slot runner + consomme du quota sans retourner de résultat.",
      suggestedAction:
        "Stopper le job depuis /pool (Jobs actifs) puis relancer si besoin. Vérifier si les seeds sont épuisés.",
      actionType: "link",
      actionPayload: { href: `/pool/${j.id}` },
      relatedEntityType: "poolJob",
      relatedEntityId: j.id,
    });
  }
  return out;
};

// ── JOBS ────────────────────────────────────────────────────────

// job_stuck — PoolJob.status='stuck'. One alert per stuck job.
export const detectJobStuck: Detector = async () => {
  const jobs = await prisma.poolJob.findMany({
    where: { status: "stuck" },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  return jobs.map((j) => ({
    code: `job_stuck:${j.id}`,
    category: "job" as const,
    severity: "warning" as const,
    title: `Job #${j.id} ${j.jobType} stuck`,
    description: `Reason: ${j.error ?? "inconnue"}.`,
    explanation: `Job ${j.jobType} lancé à ${j.startedAt.toISOString()} → stuck à ${j.endedAt?.toISOString() ?? "?"}. Reason stuck : ${j.error ?? "inconnu"}. Vérifier l'historique pour comprendre si le run a progressé partiellement.`,
    impact:
      "Le job n'avancera plus. Si c'est un scrape d'auto-refill, le pool peut ne pas remonter sans intervention.",
    suggestedAction:
      "Relancer le job si tu veux reprendre (une nouvelle row sera créée avec les stats clonées).",
    actionType: "button",
    actionPayload: {
      endpoint: `/api/pool/jobs/${j.id}/relaunch`,
      method: "POST",
      body: {},
      confirm: `Relancer le job #${j.id} ?`,
    },
    relatedEntityType: "poolJob",
    relatedEntityId: j.id,
  }));
};

// job_too_long — running > 60 min (not stuck, just slow).
export const detectJobTooLong: Detector = async () => {
  const jobs = await prisma.poolJob.findMany({
    where: {
      status: "running",
      startedAt: { lt: minutesAgo(60) },
    },
  });
  return jobs.map((j) => {
    const ageMin = Math.round((Date.now() - j.startedAt.getTime()) / 60_000);
    return {
      code: `job_too_long:${j.id}`,
      category: "job" as const,
      severity: (ageMin > 120 ? "warning" : "info") as DetectorResult["severity"],
      title: `Job #${j.id} tourne depuis ${ageMin}min`,
      description: `${j.jobType} lancé à ${j.startedAt.toISOString()}.`,
      explanation: `Un job qui tourne > 60 min n'est pas forcément stuck — scrape + engagement-fill peuvent légitimement durer ~10-40 min par cycle. Mais > 2 h c'est suspect : cron runner pourrait l'avoir pickup en boucle sans que le job progresse.`,
      impact: "Probable dérive du budget RapidAPI si le job ne converge pas.",
      suggestedAction:
        "Vérifier la page détail du job. Si 0 progression depuis 30 min, stopper + relancer.",
      actionType: "link",
      actionPayload: { href: `/pool/${j.id}` },
      relatedEntityType: "poolJob",
      relatedEntityId: j.id,
    };
  });
};

// ── CATALOGUE ──────────────────────────────────────────────────

// candidates_zero — any product with 0 eligible non-excluded candidate.
export const detectCandidatesZero: Detector = async () => {
  const products = await prisma.myBoostProduct.findMany({
    where: { isActive: true },
    select: { id: true, slug: true, displayName: true },
  });
  const out: DetectorResult[] = [];
  for (const p of products) {
    const count = await prisma.productServiceCandidate.count({
      where: {
        productId: p.id,
        isEligible: true,
        forceExcluded: false,
      },
    });
    if (count > 0) continue;
    out.push({
      code: `candidates_zero:${p.slug}`,
      category: "catalogue",
      severity: "critical",
      title: `Produit "${p.displayName}" sans candidats`,
      description: "Aucun service BulkMedya ne match ce produit actuellement.",
      explanation: `Le matcher (src/lib/catalogue/matcher.ts) n'a trouvé aucun service éligible pour le slug "${p.slug}". Vérifier : (a) le filtre du matcher est-il trop strict ? (b) BulkMedya a-t-il retiré tous les services de ce type ? (c) l'opérateur les a-t-il tous force-excluded ?`,
      impact: `/api/order avec product="${p.slug}" retournera no_eligible_service → MyBoost doit fallback sur son routing legacy pour ce SKU.`,
      suggestedAction:
        "Ouvrir le catalogue et vérifier les rules de matching, ou élargir les whitelists du matcher si un sous-type valide est rejeté à tort.",
      actionType: "link",
      actionPayload: { href: "/config/catalogue" },
      relatedEntityType: "myBoostProduct",
      relatedEntityId: p.id,
    });
  }
  return out;
};

// scoring_stale — latest ServiceScore.computedAt > 24h.
export const detectScoringStale: Detector = async () => {
  const latest = await prisma.serviceScore.findFirst({
    orderBy: { computedAt: "desc" },
    select: { computedAt: true },
  });
  if (!latest) return [];
  const ageH = (Date.now() - latest.computedAt.getTime()) / 3600_000;
  if (ageH < 24) return [];
  return [
    {
      code: "scoring_stale",
      category: "catalogue",
      severity: ageH > 72 ? "critical" : "warning",
      title: "Scoring engine silencieux depuis >24h",
      description: `Dernier ServiceScore écrit il y a ${Math.round(ageH)}h.`,
      explanation: `/api/cron/scoring tourne every 10 min et filtre les services avec au moins un TestOrder completed récent. Si aucun score n'a été écrit depuis ${Math.round(ageH)}h, soit scoringEngineEnabled=false, soit le testbot ne produit plus de measurements, soit tous les orders récents sont status='running' non encore finalisés.`,
      impact: "Le routing utilise des scores vieux de plus d'1 jour — la qualité perçue des services peut avoir dérivé.",
      suggestedAction:
        "Vérifier /pool : SCORING ENGINE est-il ACTIF ? Si oui, le testbot tourne-t-il (testBotEnabled) ? Si c'est off, rallumer.",
      actionType: "link",
      actionPayload: { href: "/pool" },
    },
  ];
};

// product_low_avg — product top3 avg score < 60 AND has ≥3 scored candidates.
export const detectProductLowAvg: Detector = async () => {
  const products = await prisma.myBoostProduct.findMany({ where: { isActive: true } });
  const out: DetectorResult[] = [];
  for (const p of products) {
    const top3 = await prisma.productServiceCandidate.findMany({
      where: {
        productId: p.id,
        isEligible: true,
        forceExcluded: false,
        currentScore: { not: null },
      },
      orderBy: [{ rank: { sort: "asc", nulls: "last" } }],
      take: 3,
      select: { currentScore: true },
    });
    if (top3.length < 3) continue;
    const avg =
      top3.reduce((a, r) => a + (r.currentScore ?? 0), 0) / top3.length;
    if (avg >= 60) continue;
    out.push({
      code: `product_low_avg:${p.slug}`,
      category: "business",
      severity: avg < 40 ? "critical" : "warning",
      title: `Produit "${p.displayName}" — top 3 moyen ${avg.toFixed(1)}`,
      description: `Les 3 meilleurs services candidats affichent un score moyen de ${avg.toFixed(1)}/100.`,
      explanation: `Même le top 3 du produit ${p.slug} est sous 60. Seuils : <60 warning, <40 critical. Cause probable : les services providers ont dégradé (completion en baisse, drop > 10 %, realism faible).`,
      impact:
        "MyBoost sert une qualité médiocre sur ce SKU. Risque de refund + perte de réputation.",
      suggestedAction:
        "Voir /config/catalogue → drawer produit pour auditer le top 3, éventuellement force-exclude les services qui ont drop. Scrape de nouveaux services BulkMedya peut aussi aider.",
      actionType: "link",
      actionPayload: { href: `/config/catalogue` },
      relatedEntityType: "myBoostProduct",
      relatedEntityId: p.id,
    });
  }
  return out;
};

// ── BUSINESS ───────────────────────────────────────────────────

// order_api_fail_rate — >5% RoutingDecision failed in last 1h.
export const detectOrderApiFailRate: Detector = async () => {
  const since = hoursAgo(1);
  const [total, failed] = await Promise.all([
    prisma.routingDecision.count({ where: { decidedAt: { gte: since } } }),
    prisma.routingDecision.count({
      where: { decidedAt: { gte: since }, success: false },
    }),
  ]);
  if (total < 20) return []; // too thin
  const rate = failed / total;
  if (rate < 0.05) return [];
  return [
    {
      code: "order_api_fail_rate",
      category: "business",
      severity: rate > 0.2 ? "critical" : "warning",
      title: `Taux d'échec /api/order = ${pct(failed, total)}%`,
      description: `${failed}/${total} commandes MyBoost ont échoué sur la dernière heure.`,
      explanation: `Seuils : >5 % warning, >20 % critical. Causes possibles : BulkMedya provider down (cascade de 502/503), all_keys_capped, service-type que MyBoost envoie qu'on n'a pas de candidate pour, DRY_RUN désactivé alors que les clés ne sont pas valides.`,
      impact: "MyBoost doit fallback sur son routing legacy → perte de la valeur ajoutée de CONTROL.",
      suggestedAction:
        "Check /logs pour les erreurs récentes. Si BulkMedya retourne des erreurs consistantes, ping leur support. Si c'est un service-type non couvert, élargir le catalogue.",
      actionType: "link",
      actionPayload: { href: "/logs" },
    },
  ];
};

// ── TESTBOT ────────────────────────────────────────────────────

// test_retry_rate_high — > 30% TestOrder avec retryCount>0 sur 24h.
export const detectTestRetryRateHigh: Detector = async () => {
  const since = hoursAgo(24);
  const [total, retried] = await Promise.all([
    prisma.testOrder.count({ where: { placedAt: { gte: since } } }),
    prisma.testOrder.count({
      where: { placedAt: { gte: since }, retryCount: { gt: 0 } },
    }),
  ]);
  if (total < 10) return [];
  const rate = retried / total;
  if (rate < 0.3) return [];
  return [
    {
      code: "test_retry_rate_high",
      category: "testbot",
      severity: rate > 0.5 ? "critical" : "warning",
      title: `Taux de retry testbot élevé : ${pct(retried, total)}%`,
      description: `${retried}/${total} TestOrder placés sur 24h sont issus d'un retry auto (cible morte mid-test).`,
      explanation: `Le testbot auto-retry quand le compte cible meurt en cours de test. Un taux >30 % = le pool est fragile (comptes qui se font bannir/supprimer en permanence). Chaque retry = nouvelle commande BulkMedya = nouveau coût.`,
      impact:
        "Coût réel BulkMedya en hausse invisible. Si le pool de qualité continue à pourrir, le test-bot pédale dans le vide.",
      suggestedAction:
        "Vérifier les sources de scraping (seeds) — certaines peuvent donner des comptes junk qui se font ban vite. Tester l'augmentation du health-check plus fréquent.",
      actionType: "link",
      actionPayload: { href: "/pool" },
    },
  ];
};

// test_abort_rate_high — >20% TestOrder status='aborted_target_died' sur 24h.
export const detectTestAbortRateHigh: Detector = async () => {
  const since = hoursAgo(24);
  const [total, aborted] = await Promise.all([
    prisma.testOrder.count({ where: { placedAt: { gte: since } } }),
    prisma.testOrder.count({
      where: { placedAt: { gte: since }, status: "aborted_target_died" },
    }),
  ]);
  if (total < 10) return [];
  const rate = aborted / total;
  if (rate < 0.2) return [];
  return [
    {
      code: "test_abort_rate_high",
      category: "testbot",
      severity: rate > 0.4 ? "critical" : "warning",
      title: `Taux d'abort testbot : ${pct(aborted, total)}%`,
      description: `${aborted}/${total} tests sur 24h aborted (cible morte sans retry réussi).`,
      explanation: `Seuils : >20 % warning, >40 % critical. Soit l'auto-retry ne trouve plus de target sain dans le pool (épuisement), soit on scrape des comptes à durée de vie très courte.`,
      impact: "Les tests abortés ne sont pas comptés dans le scoring → la moyenne glissante peut être lag. Le ratio signalé/total augmente le coût par test réussi.",
      suggestedAction:
        "Investiguer la qualité du pool. Si le pool est sain mais les tests abortent, c'est que BulkMedya delivery tue les comptes (quality issue côté provider).",
      actionType: "link",
      actionPayload: { href: "/pool" },
    },
  ];
};

// ── INFRA / CONFIG ─────────────────────────────────────────────

// dry_run_off_with_testbot — surfaces the "production mode" state
// so the operator never loses track that real BulkMedya budget is
// being spent. Info-only; this isn't a bug, just a state we want
// visible alongside the standard alert feed.
export const detectDryRunOffWithTestbot: Detector = async () => {
  const { getSystemToggles } = await import("@/lib/system/toggles");
  const t = await getSystemToggles();
  if (t.dryRunMode !== false || !t.testBotEnabled) return [];

  // Pull today's placement count + approximate cost. We estimate
  // cost via the SUM of Service.ratePerK * targetQuantity / 1000
  // over TestOrders placed today where dryRun=false (i.e. real
  // BulkMedya orders).
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const realOrdersToday = await prisma.testOrder.findMany({
    where: {
      placedAt: { gte: startOfDay },
      dryRun: false,
    },
    include: { service: { select: { ratePerK: true } } },
  });
  const placedCount = realOrdersToday.length;
  const estimatedCost = realOrdersToday.reduce((acc, o) => {
    const rate = o.service?.ratePerK ?? 0;
    return acc + (rate * o.targetQuantity) / 1000;
  }, 0);

  return [
    {
      code: "dry_run_off_with_testbot",
      category: "infra",
      severity: "info",
      title: "Mode production actif",
      description:
        "DRY RUN désactivé — le testbot passe de vraies commandes BulkMedya.",
      explanation: `État des toggles : dryRunMode=false, testBotEnabled=true, scoringEngineEnabled=${t.scoringEngineEnabled ? "true" : "false"}. Depuis 00:00 UTC aujourd'hui : ${placedCount} commandes réelles placées, coût estimé ≈ ${estimatedCost.toFixed(2)} $ (basé sur Service.ratePerK × targetQuantity). Le calcul est approximatif — BulkMedya facture au final selon la livraison réelle.`,
      impact:
        "Chaque test testbot consomme du solde BulkMedya. Si la qualité des mesures baisse ou si le catalogue est mal classé, l'argent est dépensé sans retour utile.",
      suggestedAction:
        "Surveiller le solde BulkMedya + la qualité des mesures sur /services. Si un doute apparaît (errors batch, scores qui s'effondrent), remettre DRY RUN sur SIMULATION depuis /pool → KILL SWITCH.",
      actionType: "link",
      actionPayload: { href: "/pool#kill-switch" },
    },
  ];
};

// ── Registry ───────────────────────────────────────────────────

export const DETECTORS: Detector[] = [
  detectKeyNearCap,
  detectKeyCapped,
  detectAllKeysCapped,
  detectRateLimiterSaturated,
  detectPoolBelowMin,
  detectPoolHighInvalidation,
  detectSeedsExhausted,
  detectScrapeStale,
  detectJobStuck,
  detectJobTooLong,
  detectCandidatesZero,
  detectScoringStale,
  detectProductLowAvg,
  detectOrderApiFailRate,
  detectTestRetryRateHigh,
  detectTestAbortRateHigh,
  detectDryRunOffWithTestbot,
];

// ── Deferred detectors (need instrumentation we don't have yet) ──
//
// upstash_slow       — needs a ring buffer of redis.eval() response
//                      times. Add lib/rapidapi/rate-limit.ts metric.
// vercel_errors      — needs Vercel logs REST API integration +
//                      scheduled scrape. Pro-plan feature.
// supabase_slow      — needs prisma middleware timing all queries.
//                      Invasive, defer until we actually observe an
//                      issue.
// provider_down      — needs a tumbling-window counter of RapidAPI
//                      5xx responses. Fold into ig-client on next
//                      rate-limit refactor.
// bulkmedya_low_balance — needs a BulkMedya /balance endpoint which
//                      the provider does not expose through v2.
// job_error_rate_high — redundant with scrape_stale + job_stuck for
//                      v1; revisit if the first two miss cases.
