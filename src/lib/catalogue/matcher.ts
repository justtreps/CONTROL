// Matches BulkMedya Service rows against MyBoost products.
//
// One predicate per product slug. Each predicate returns
//   { match: boolean; country: string | null }
// on a service's (name, platform). Rules per product slug are
// the ones operators actually trust — spelled out below, not
// buried in layered regex gates. Keep them explicit so a future
// Amir-or-Claude can read the file top-to-bottom and audit
// classification without spelunking.
//
// Inclusion-first discipline:
//   • MUST contain the product keyword in the service name
//     (case-insensitive, word-boundary)
//   • MUST NOT contain any of the product's exclusion words
//   • geo emoji + country keywords are stripped BEFORE the
//     inclusion/exclusion test so "🇧🇷 Instagram Brazil Likes"
//     still passes ig-likes and stores "BR" as target country
//
// Called from:
//   • syncServices (lib/bulkmedya.ts) after every sync — new rows
//   • /api/catalogue/rematch                      — manual button
//   • seed migration one-shot after `db push`     — initial fill

import { prisma } from "@/lib/prisma";
import { detectCountry } from "@/lib/services/classifier";
import { PRODUCT_SEEDS } from "./products";

export type MatchResult = {
  match: boolean;
  country: string | null;
};

export type ServiceLite = {
  id: number;
  name: string;
  platform: string;
  active: boolean;
};

// Emoji + country-prefix stripper (see prior comment — ES2017
// targets so we avoid Unicode property escapes).
const EMOJI_RX = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const COUNTRY_PREFIX_RX =
  /\b(brazil|brasil|france|french|usa|uk|germany|spain|italy|india|mexico|turkey|japan|korea|china|russia|indonesia|nigeria|arab|saudi|iran|pakistan|bangladesh|morocco|egypt|arabian|iranian|turkish|italian|german|spanish|brazilian|american)\b/gi;

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(EMOJI_RX, "")
    .replace(COUNTRY_PREFIX_RX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Quality floor — services marked bot / fake / spam never get
// routed to production regardless of otherwise-matching keywords.
// Still applied on top of the per-product rules so operators don't
// have to list "bot" in every exclusion list.
const BOT_FAKE_RX = /\b(bot|fake|spam)\b/i;

// "Auto" services (auto-likes / auto-views / auto-followers that
// fire on schedule) are a different SKU from single-shot orders —
// exclude from the catalog by default.
const AUTO_RX = /\bauto\b/i;

// Deprecated products — Meta killed IGTV in 2022, all migrated to
// Reels. Any service still mentioning IGTV in its name is by
// definition obsolete (provider didn't update naming, or BulkMedya
// still has stale rows). Word-boundary so "instagram tv" or
// embedded substrings don't false-positive — but the BulkMedya
// catalogue has historically used the literal token "igtv" and
// "ig tv" with a space, so we cover both.
const DEPRECATED_PRODUCT_RX = /\b(igtv|ig\s*tv)\b/i;

// Helper: returns true if normalised name contains ALL given
// word-bounded tokens.
function containsAll(n: string, tokens: string[]): boolean {
  for (const t of tokens) {
    const rx = new RegExp(`\\b${t}\\b`, "i");
    if (!rx.test(n)) return false;
  }
  return true;
}

// Helper: returns true if normalised name contains ANY given
// word-bounded token.
function containsAny(n: string, tokens: string[]): boolean {
  for (const t of tokens) {
    const rx = new RegExp(`\\b${t}\\b`, "i");
    if (rx.test(n)) return true;
  }
  return false;
}

type Matcher = (s: ServiceLite) => MatchResult;

function fail(): MatchResult {
  return { match: false, country: null };
}

function ok(s: ServiceLite): MatchResult {
  return { match: true, country: detectCountry(s.name) };
}

function baseGate(s: ServiceLite, expectedPlatform: string): boolean {
  if (!s.active) return false;
  if (s.platform !== expectedPlatform) return false;
  const n = s.name.toLowerCase();
  if (BOT_FAKE_RX.test(n)) return false;
  if (AUTO_RX.test(n)) return false;
  // Block ALL IGTV-named services across every product slug —
  // Meta killed the product, no point routing it. Future syncs
  // will land them as out-of-scope which is correct: they don't
  // map to any of the 8 MyBoost SKUs.
  if (DEPRECATED_PRODUCT_RX.test(n)) return false;
  return true;
}

// ───────────────────────────────────────────────────────────────
// Per-product rules. Include / exclude lists come straight from
// the product brief; edit here when the catalogue expands.
// ───────────────────────────────────────────────────────────────

// ig-followers: IG + "followers" AND NOT (channel | member |
//   subscribe | subscriber). Excludes broadcast-channel services.
const matchIgFollowers: Matcher = (s) => {
  if (!baseGate(s, "instagram")) return fail();
  const n = normalise(s.name);
  if (!containsAll(n, ["followers?"])) return fail();
  if (containsAny(n, ["channel", "members?", "subscribers?", "subscribe"]))
    return fail();
  return ok(s);
};

// ig-likes: IG + "likes" AND NOT (views | comment | reaction |
//   story). Story likes and reactions are different SKUs.
const matchIgLikes: Matcher = (s) => {
  if (!baseGate(s, "instagram")) return fail();
  const n = normalise(s.name);
  if (!containsAll(n, ["likes?"])) return fail();
  if (containsAny(n, ["views?", "comments?", "reactions?", "stor(?:y|ies)"]))
    return fail();
  return ok(s);
};

// ig-views: IG + ("views" OR "reel views" OR "video views") AND
//   NOT (story | live | igtv). "profile views" is vanity, filtered
//   out as a live keyword — the user's spec doesn't explicitly
//   exclude it but it's not a content view.
const matchIgViews: Matcher = (s) => {
  if (!baseGate(s, "instagram")) return fail();
  const n = normalise(s.name);
  if (!containsAny(n, ["views?", "reel views?", "video views?"])) return fail();
  if (containsAny(n, ["stor(?:y|ies)", "live", "igtv", "ig tv", "profile views?"]))
    return fail();
  return ok(s);
};

// tt-followers: TT + "followers" AND NOT (live | channel).
const matchTtFollowers: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!containsAll(n, ["followers?"])) return fail();
  if (containsAny(n, ["live", "channel"])) return fail();
  return ok(s);
};

// tt-likes: TT + "likes" AND NOT (views | comment).
const matchTtLikes: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!containsAll(n, ["likes?"])) return fail();
  if (containsAny(n, ["views?", "comments?"])) return fail();
  return ok(s);
};

// tt-views: TT + "views" AND NOT (live | ads).
const matchTtViews: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!containsAll(n, ["views?"])) return fail();
  if (containsAny(n, ["live", "ads"])) return fail();
  return ok(s);
};

// tt-shares: TT + "share" or "shares". Reshare stays a different
//   SKU (different upstream token) — matched by substring would
//   false-positive, so we keep "reshare" explicit.
const matchTtShares: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!containsAny(n, ["shares?"])) return fail();
  if (containsAny(n, ["reshares?"])) return fail();
  return ok(s);
};

// tt-saves: TT + ("saves" OR "save" OR "bookmark"). Favorites is
//   the same thing on TT UI, kept from the prior rule.
const matchTtSaves: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!containsAny(n, ["saves?", "bookmarks?", "favou?rites?"])) return fail();
  return ok(s);
};

const MATCHERS: Record<string, Matcher> = {
  "ig-followers": matchIgFollowers,
  "ig-likes": matchIgLikes,
  "ig-views": matchIgViews,
  "tt-followers": matchTtFollowers,
  "tt-likes": matchTtLikes,
  "tt-views": matchTtViews,
  "tt-shares": matchTtShares,
  "tt-saves": matchTtSaves,
};

export function matchService(
  slug: string,
  s: ServiceLite
): MatchResult {
  const fn = MATCHERS[slug];
  if (!fn) return fail();
  return fn(s);
}

// Returns the list of product slugs a service matches. Used by
// rematchAll to flag out-of-scope services (zero matches across
// all 8 products) so the campaign launcher + routing skip them.
export function matchAllProducts(s: ServiceLite): string[] {
  const matched: string[] = [];
  for (const slug of Object.keys(MATCHERS)) {
    if (MATCHERS[slug](s).match) matched.push(slug);
  }
  return matched;
}

// ── Bulk rematch ────────────────────────────────────────────────

export type RematchResult = {
  products: number;
  servicesChecked: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  candidatesMarkedIneligible: number;
  // Services that don't match ANY of the 8 products — the campaign
  // launcher + routing layer skip these rows entirely.
  servicesOutOfScope: number;
  perProduct: Record<
    string,
    { eligible: number; ineligible: number; geoTagged: number }
  >;
};

export async function rematchAll(): Promise<RematchResult> {
  // Make sure every product in PRODUCT_SEEDS is present — cheap
  // upsert so rematch works even before the seed endpoint ran.
  for (const p of PRODUCT_SEEDS) {
    await prisma.myBoostProduct.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        displayName: p.displayName,
        platform: p.platform,
        productType: p.productType,
      },
      update: {
        displayName: p.displayName,
        platform: p.platform,
        productType: p.productType,
      },
    });
  }

  const products = await prisma.myBoostProduct.findMany({
    where: { isActive: true },
    select: { id: true, slug: true },
  });

  const services = await prisma.service.findMany({
    select: { id: true, name: true, platform: true, active: true },
  });

  const result: RematchResult = {
    products: products.length,
    servicesChecked: services.length,
    candidatesCreated: 0,
    candidatesUpdated: 0,
    candidatesMarkedIneligible: 0,
    servicesOutOfScope: 0,
    perProduct: {},
  };
  for (const p of products) {
    result.perProduct[p.slug] = { eligible: 0, ineligible: 0, geoTagged: 0 };
  }

  // First pass — per-service matching across all products. We need
  // the full per-service result up front so we can count
  // out-of-scope rows (zero matches) after the upserts.
  const serviceMatches = new Map<
    number,
    Array<{ productId: number; slug: string; country: string | null }>
  >();
  for (const s of services) {
    const hits: Array<{ productId: number; slug: string; country: string | null }> = [];
    for (const p of products) {
      const m = matchService(p.slug, s);
      if (m.match) hits.push({ productId: p.id, slug: p.slug, country: m.country });
    }
    serviceMatches.set(s.id, hits);
    if (hits.length === 0) result.servicesOutOfScope++;
  }

  // Second pass — reconcile ProductServiceCandidate rows. For each
  // (product, service), upsert candidacy based on the matcher
  // result. Chunked Promise.all for DB write throughput.
  const CHUNK = 50;
  for (const p of products) {
    for (let i = 0; i < services.length; i += CHUNK) {
      const chunk = services.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map(async (s) => {
          const hits = serviceMatches.get(s.id) ?? [];
          const hit = hits.find((h) => h.productId === p.id);
          const matched = Boolean(hit);
          const country = hit?.country ?? null;

          const existing = await prisma.productServiceCandidate.findUnique({
            where: {
              productId_serviceId: { productId: p.id, serviceId: s.id },
            },
            select: { id: true, isEligible: true, forceExcluded: true },
          });

          if (!existing) {
            if (!matched) return;
            await prisma.productServiceCandidate.create({
              data: {
                productId: p.id,
                serviceId: s.id,
                isEligible: true,
                targetCountry: country,
              },
            });
            result.candidatesCreated++;
            const bucket = result.perProduct[p.slug];
            bucket.eligible++;
            if (country) bucket.geoTagged++;
            return;
          }

          // Row exists — update isEligible + targetCountry. Don't
          // touch forceExcluded (operator-set) or scoring fields.
          if (existing.isEligible !== matched) {
            await prisma.productServiceCandidate.update({
              where: { id: existing.id },
              data: { isEligible: matched, targetCountry: country },
            });
            result.candidatesUpdated++;
            if (!matched) result.candidatesMarkedIneligible++;
          } else if (matched) {
            await prisma.productServiceCandidate.update({
              where: { id: existing.id },
              data: { targetCountry: country },
            });
          }

          const bucket = result.perProduct[p.slug];
          if (matched) {
            bucket.eligible++;
            if (country) bucket.geoTagged++;
          } else {
            bucket.ineligible++;
          }
        })
      );
    }
  }

  return result;
}
