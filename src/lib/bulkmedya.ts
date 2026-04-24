import { getBulkmedyaKey } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { SCOPE } from "@/lib/scope";
import { classifyService } from "@/lib/services/classifier";

const BULKMEDYA_URL = process.env.BULKMEDYA_API_URL ?? "https://bulkmedya.org/api/v2";

type RawService = {
  service: string | number;
  name: string;
  type?: string;
  category?: string;
  rate: string | number;
  min: string | number;
  max: string | number;
  refill?: boolean;
  cancel?: boolean;
};

export type BulkmedyaOrderResponse = { order: number } | { error: string };

async function bulkmedyaPost<T>(params: Record<string, string | number>): Promise<T> {
  const key = await getBulkmedyaKey();
  if (!key) throw new Error("BulkMedya API key not configured");

  const body = new URLSearchParams({ key, ...Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ) });

  const res = await fetch(BULKMEDYA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`BulkMedya HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

const PLATFORM_KEYWORDS: Array<[string, string[]]> = [
  ["instagram", ["instagram", "insta ", "ig "]],
  ["tiktok", ["tiktok", "tik tok", "tik-tok"]],
  ["youtube", ["youtube", "yt "]],
  ["twitter", ["twitter", "x.com"]],
  ["facebook", ["facebook", "fb "]],
  ["telegram", ["telegram"]],
  ["spotify", ["spotify"]],
];

// STRICT PRIORITY ORDER — specific-before-generic to avoid misclassifying
// "INSTAGRAM REAL LIKES" as followers because a substring like "follower"
// accidentally matches. Regex uses word boundaries (\b) so "view" doesn't
// match inside "viewers" or "preview" — each term is listed explicitly in
// singular + plural forms (EN + FR).
//
// Order matters: likes > views > comments > shares > saves > stories >
// live_viewers > followers. When the same text mentions several, the more
// specific one (e.g. "likes") wins over the broader category keyword.
const TYPE_TESTS: Array<[string, RegExp]> = [
  ["likes",        /\b(likes?|j'aimes?)\b/i],
  ["views",        /\b(views?|vues?|visionnages?|plays?)\b/i],
  ["comments",     /\b(comments?|commentaires?)\b/i],
  ["shares",       /\b(shares?|partages?|reposts?)\b/i],
  ["saves",        /\b(saves?|sauvegardes?|enregistrements?|bookmarks?)\b/i],
  ["stories",      /\b(story|stories)\b/i],
  ["live_viewers", /\b(lives?|viewers?)\b/i],
  ["followers",    /\b(followers?|abonn[eé]es?|subscribers?|subs)\b/i],
];

export function classifyServiceType(name: string, category: string): string {
  // Join name + category into one haystack and let the strict priority
  // regexes pick the winner. Priority order (likes → views → comments →
  // shares → saves → stories → live_viewers → followers) resolves
  // collisions like "Instagram Brazil Real Likes" when BulkMedya files
  // the service under a generic "Followers" category — the specific
  // "likes" token wins over the broader category label.
  const haystack = `${name ?? ""} ${category ?? ""}`.toLowerCase();
  for (const [t, rx] of TYPE_TESTS) {
    if (rx.test(haystack)) return t;
  }
  return "other";
}

function classify(name: string, category: string) {
  const haystack = `${name} ${category}`.toLowerCase();
  let platform = "unknown";
  for (const [p, kws] of PLATFORM_KEYWORDS) {
    if (kws.some((k) => haystack.includes(k))) {
      platform = p;
      break;
    }
  }
  const serviceType = classifyServiceType(name, category);
  return { platform, serviceType };
}

export async function fetchServices(): Promise<RawService[]> {
  return bulkmedyaPost<RawService[]>({ action: "services" });
}

export type SyncResult = {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
  skippedOutOfScope: number;
};

export async function syncServices(): Promise<SyncResult> {
  const raw = await fetchServices();
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected services response: ${JSON.stringify(raw).slice(0, 200)}`);
  }

  // Platform scope — we only keep services from platforms flagged
  // enabled=true in SCOPE (IG + TT for now). We no longer gate per
  // (platform, serviceType) pair: likes / views / shares / saves
  // are all ingested so the full engagement catalog is available
  // once BulkMedya data is live. Per-type visibility in the UI is
  // still driven by the mvp flag in ServicesNav.
  const enabledPlatforms = new Set<string>(
    SCOPE.platforms.filter((p) => p.enabled).map((p) => p.id)
  );
  const keptIds = new Set<number>();
  let created = 0;
  let updated = 0;
  let skippedOutOfScope = 0;

  for (const r of raw) {
    const bulkmedyaId = Number(r.service);
    if (!Number.isFinite(bulkmedyaId)) continue;

    const { platform, serviceType } = classify(r.name, r.category ?? "");

    if (!enabledPlatforms.has(platform)) {
      skippedOutOfScope++;
      continue;
    }

    keptIds.add(bulkmedyaId);

    // Run the strict-whitelist classifier to stamp poolType /
    // targetCountry / manualReview / active at sync time. Avoids
    // the "new services sit as poolType=unknown until operator
    // clicks Reclassifier" gap that the old flow had.
    const cls = classifyService({ name: r.name, platform });

    const data = {
      bulkmedyaId,
      name: r.name,
      category: r.category ?? "",
      platform,
      serviceType,
      ratePerK: Number(r.rate) || 0,
      minQuantity: Number(r.min) || 0,
      maxQuantity: Number(r.max) || 0,
      refillSupported: Boolean(r.refill),
      cancelSupported: Boolean(r.cancel),
      poolType: cls.poolType,
      targetCountry: cls.targetCountry,
      classificationManualReview: cls.classificationManualReview,
      active: cls.active,
    };

    const existing = await prisma.service.findUnique({ where: { bulkmedyaId } });
    if (existing) {
      // Preserve operator manual overrides on updates: if the row
      // already has classificationManualReview=false AND poolType is
      // set to something explicit by the operator, don't overwrite.
      // Heuristic: if the current classifier would reach the same
      // verdict as the operator picked, the update is a no-op.
      // Otherwise leave the operator's call alone and only update
      // the non-classification fields.
      const preserveOperator =
        existing.classificationManualReview === false &&
        existing.poolType !== "unknown" &&
        existing.poolType !== cls.poolType;
      if (preserveOperator) {
        await prisma.service.update({
          where: { bulkmedyaId },
          data: {
            name: data.name,
            category: data.category,
            platform: data.platform,
            serviceType: data.serviceType,
            ratePerK: data.ratePerK,
            minQuantity: data.minQuantity,
            maxQuantity: data.maxQuantity,
            refillSupported: data.refillSupported,
            cancelSupported: data.cancelSupported,
            // classification fields kept as-is
          },
        });
      } else {
        await prisma.service.update({ where: { bulkmedyaId }, data });
      }
      updated++;
    } else {
      await prisma.service.create({ data });
      created++;
    }
  }

  // Any DB row that's currently active but didn't survive the scope
  // filter this run gets deactivated (kept for history, hidden from
  // scoring / router / UI).
  const deactivated = await prisma.service.updateMany({
    where: {
      active: true,
      bulkmedyaId: { notIn: Array.from(keptIds) },
    },
    data: { active: false },
  });

  const kept = created + updated;
  console.log(
    `[syncServices] fetched=${raw.length} kept=${kept} (created=${created}, updated=${updated}) skipped=${skippedOutOfScope} deactivated=${deactivated.count}`
  );

  return {
    total: raw.length,
    created,
    updated,
    deactivated: deactivated.count,
    skippedOutOfScope,
  };
}

export type ReparseResult = {
  total: number;
  corrected: number;
  deactivatedOutOfScope: number;
  reactivatedBackInScope: number;
  corrections: Array<{
    id: number;
    bulkmedyaId: number;
    name: string;
    from: string;
    to: string;
    activeFrom: boolean;
    activeTo: boolean;
  }>;
};

// One-off migration: re-run classifyServiceType() against every Service row
// in DB and fix rows whose stored type disagrees with the current parser.
// Also re-applies the MVP scope filter (deactivates rows that fall out,
// reactivates rows that come back in — e.g. a row previously mistyped as
// "likes" that's actually "followers" and should be live again).
export async function reparseServiceTypes(): Promise<ReparseResult> {
  const rows = await prisma.service.findMany({
    select: {
      id: true,
      bulkmedyaId: true,
      name: true,
      category: true,
      platform: true,
      serviceType: true,
      active: true,
    },
  });

  // Mirror syncServices: scope by platform only (enabled=true) so a
  // reparse run doesn't undo the broader catalog we're now ingesting
  // (engagement-type rows stay active on IG+TT).
  const enabledPlatforms = new Set<string>(
    SCOPE.platforms.filter((p) => p.enabled).map((p) => p.id)
  );

  const corrections: ReparseResult["corrections"] = [];
  let corrected = 0;
  let deactivatedOutOfScope = 0;
  let reactivatedBackInScope = 0;

  for (const r of rows) {
    const newType = classifyServiceType(r.name, r.category);
    const inScope = enabledPlatforms.has(r.platform);
    const shouldBeActive = inScope;

    const typeChanged = newType !== r.serviceType;
    const activeChanged = shouldBeActive !== r.active;

    if (!typeChanged && !activeChanged) continue;

    await prisma.service.update({
      where: { id: r.id },
      data: {
        serviceType: newType,
        active: shouldBeActive,
      },
    });

    corrections.push({
      id: r.id,
      bulkmedyaId: r.bulkmedyaId,
      name: r.name,
      from: r.serviceType,
      to: newType,
      activeFrom: r.active,
      activeTo: shouldBeActive,
    });

    if (typeChanged) corrected++;
    if (activeChanged && !shouldBeActive) deactivatedOutOfScope++;
    if (activeChanged && shouldBeActive) reactivatedBackInScope++;

    console.log(
      `[reparse] #${r.bulkmedyaId} "${r.name.slice(0, 60)}" ${r.serviceType}→${newType} active:${r.active}→${shouldBeActive}`
    );
  }

  console.log(
    `[reparse] total=${rows.length} corrected=${corrected} deactivated=${deactivatedOutOfScope} reactivated=${reactivatedBackInScope}`
  );

  return {
    total: rows.length,
    corrected,
    deactivatedOutOfScope,
    reactivatedBackInScope,
    corrections,
  };
}

export async function placeOrder(params: {
  service: number;
  link: string;
  quantity: number;
}): Promise<BulkmedyaOrderResponse> {
  return bulkmedyaPost<BulkmedyaOrderResponse>({
    action: "add",
    service: params.service,
    link: params.link,
    quantity: params.quantity,
  });
}
