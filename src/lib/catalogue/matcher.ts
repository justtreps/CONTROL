// Matches BulkMedya Service rows against MyBoost products.
//
// One predicate per product slug. Each predicate returns
//   { match: boolean; country: string | null }
// on a service's (name, platform). The predicate assumes the
// classifier has already stripped platform/service out into DB
// columns, but still re-inspects the raw name because BulkMedya
// mashes sub-types (story / reel / video / live) into the name
// rather than the DB-level serviceType.
//
// "Strict whitelist" discipline:
//   • single inclusion keyword for the product type
//   • explicit blacklist for every sub-variant the operator doesn't
//     want routed (story likes / reel views / auto / bot / fake …)
//   • geo emoji + country keywords are stripped BEFORE the keyword
//     test so "🇧🇷 Instagram Brazil Likes" passes ig-likes and stores
//     "BR" as target country
//
// Called from three places:
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

// Emoji + country-prefix stripper. Removes flag emojis and common
// country-prefix patterns so keyword tests don't see them.
// The matcher uses detectCountry() on the RAW name to capture the
// geo signal before this stripping runs.
//
// We use a surrogate-pair regex instead of the cleaner
// /\p{Extended_Pictographic}/gu because the project's tsconfig
// targets pre-ES2018 (the `u` flag + Unicode property escapes need
// ES2018+). The surrogate pair range [D800-DBFF][DC00-DFFF] covers
// every non-BMP codepoint, which is where every emoji lives —
// including the regional-indicator pairs that compose flag emojis.
const EMOJI_RX = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const COUNTRY_PREFIX_RX = /\b(brazil|brasil|france|french|usa|uk|germany|spain|italy|india|mexico|turkey|japan|korea|china|russia|indonesia|nigeria|arab|saudi|iran|pakistan|bangladesh|morocco|egypt|arabian|iranian|turkish|italian|german|spanish|brazilian|american)\b/gi;

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(EMOJI_RX, "")
    .replace(COUNTRY_PREFIX_RX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Global rejects — same keywords the classifier disables. Applied
// before any whitelist so a "Story Views" row never passes ig-views.
const DISABLE_TOPIC_RX =
  /\b(stor(?:y|ies)|igtv|instagram\s+tv|ig\s*tv|livestreams?|live\s*stream(?:ing)?|live\s*stream\s*(?:views?|viewers?)|live\s*viewers?|live\s*views?|live\s*chat|impressions?|reach(?:es)?|profile\s*visits?|mentions?|autoplays?|reposts?|reposte[rs]?|poll(?:s|es)?|votes?|quiz(?:z?es)?|reactions?|comment(?:s|aire[s]?)?)\b/i;

// Noise adjectives that should be manual-only (bot / fake).
const BOT_FAKE_RX = /\b(bot|fake|spam)\b/i;

// "Auto" services (auto-likes / auto-views / auto-followers that
// fire on schedule) are a different SKU from single-shot orders —
// exclude from the catalog.
const AUTO_RX = /\bauto\b/i;

type Matcher = (s: ServiceLite) => MatchResult;

function fail(): MatchResult {
  return { match: false, country: null };
}

function ok(s: ServiceLite): MatchResult {
  return { match: true, country: detectCountry(s.name) };
}

// Helper — platform + no topic-level rejections.
function baseGate(s: ServiceLite, expectedPlatform: string): boolean {
  if (!s.active) return false;
  if (s.platform !== expectedPlatform) return false;
  if (DISABLE_TOPIC_RX.test(s.name)) return false;
  return true;
}

// ───────────────────────────────────────────────────────────────
// Per-product predicates.
//
// Comment for each one carries the exact spec wording so the rules
// are traceable back to the product brief.
// ───────────────────────────────────────────────────────────────

// ig-followers: name contains "follower" on IG. Exclude bot/fake/spam.
const matchIgFollowers: Matcher = (s) => {
  if (!baseGate(s, "instagram")) return fail();
  const n = normalise(s.name);
  if (!/\bfollowers?\b/.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// ig-likes: "likes" only. Exclude story/reel/auto/video likes + bot/fake.
const matchIgLikes: Matcher = (s) => {
  if (!baseGate(s, "instagram")) return fail();
  const n = normalise(s.name);
  if (!/\blikes?\b/.test(n)) return fail();
  // All the reel/video/auto variants go to their own SKUs or are not
  // sold at all. baseGate already killed story/reel variants via the
  // disable topic rx, but we add the explicit check for redundancy +
  // the "video likes" case which doesn't share a stem with story.
  if (/\b(video|reel)\s+likes?\b/.test(n)) return fail();
  if (AUTO_RX.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// ig-views: "views" only. Exclude story/reel/video/profile views + auto + bot/fake.
const matchIgViews: Matcher = (s) => {
  if (!baseGate(s, "instagram")) return fail();
  const n = normalise(s.name);
  if (!/\bviews?\b/.test(n)) return fail();
  if (/\b(video|reel|story|profile)\s+views?\b/.test(n)) return fail();
  if (AUTO_RX.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// tt-followers: "follower" on TikTok.
const matchTtFollowers: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!/\bfollowers?\b/.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// tt-likes: "likes" on TikTok.
const matchTtLikes: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!/\blikes?\b/.test(n)) return fail();
  if (AUTO_RX.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// tt-views: "views" on TikTok — "video views" is the standard TT
// naming (every TT views service is by definition on a video) so we
// accept it instead of blacklisting.
const matchTtViews: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!/\bviews?\b/.test(n)) return fail();
  if (AUTO_RX.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// tt-shares: "share"/"shares" on TT. Reshare is excluded by the
// topic disable (it matches "reposts?").
const matchTtShares: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!/\bshares?\b/.test(n)) return fail();
  if (/\breshares?\b/.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
  return ok(s);
};

// tt-saves: "save"/"saves"/"favorite"/"bookmark" on TT.
const matchTtSaves: Matcher = (s) => {
  if (!baseGate(s, "tiktok")) return fail();
  const n = normalise(s.name);
  if (!/\b(saves?|favou?rites?|bookmarks?)\b/.test(n)) return fail();
  if (BOT_FAKE_RX.test(n)) return fail();
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

// ── Bulk rematch ────────────────────────────────────────────────

export type RematchResult = {
  products: number;
  servicesChecked: number;
  candidatesCreated: number;
  candidatesUpdated: number;
  candidatesMarkedIneligible: number;
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
    perProduct: {},
  };
  for (const p of products) {
    result.perProduct[p.slug] = { eligible: 0, ineligible: 0, geoTagged: 0 };
  }

  // For each (product, service) — upsert candidacy.
  // Matches O(P × S) = 8 × 5k = 40k evaluations, each an in-memory
  // regex — fast enough. DB writes are the bottleneck, so we batch
  // the upserts within Promise.all chunks.
  const CHUNK = 50;
  for (const p of products) {
    for (let i = 0; i < services.length; i += CHUNK) {
      const chunk = services.slice(i, i + CHUNK);
      await Promise.all(
        chunk.map(async (s) => {
          const m = matchService(p.slug, s);
          const existing = await prisma.productServiceCandidate.findUnique({
            where: {
              productId_serviceId: {
                productId: p.id,
                serviceId: s.id,
              },
            },
            select: { id: true, isEligible: true, forceExcluded: true },
          });

          if (!existing) {
            if (!m.match) return; // no row needed
            await prisma.productServiceCandidate.create({
              data: {
                productId: p.id,
                serviceId: s.id,
                isEligible: true,
                targetCountry: m.country,
              },
            });
            result.candidatesCreated++;
            const bucket = result.perProduct[p.slug];
            bucket.eligible++;
            if (m.country) bucket.geoTagged++;
            return;
          }

          // Row already exists — update eligibility only. Don't
          // touch forceExcluded (operator-set) or scoring fields.
          if (existing.isEligible !== m.match) {
            await prisma.productServiceCandidate.update({
              where: { id: existing.id },
              data: {
                isEligible: m.match,
                targetCountry: m.country,
              },
            });
            result.candidatesUpdated++;
            if (!m.match) result.candidatesMarkedIneligible++;
          } else if (m.match) {
            // Keep targetCountry fresh even if eligibility didn't
            // change — name may have been edited on a re-sync.
            await prisma.productServiceCandidate.update({
              where: { id: existing.id },
              data: { targetCountry: m.country },
            });
          }

          const bucket = result.perProduct[p.slug];
          if (m.match) {
            bucket.eligible++;
            if (m.country) bucket.geoTagged++;
          } else {
            bucket.ineligible++;
          }
        })
      );
    }
  }

  return result;
}
