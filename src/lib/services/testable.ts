// Single source of truth for "is this service sellable on MyBoost?"
//
// The testbot runs its cycle against sellable services only so scoring
// isn't polluted with noise from services we'll never route to (manual
// review flags, buckets we don't monetize, non-MyBoost platforms).
// The same predicate drives the badge on /config/services-review so
// operators can cross-check visually.

export const SELLABLE_PLATFORMS = ["instagram", "tiktok"] as const;

export const SELLABLE_SERVICE_TYPES = [
  "followers",
  "likes",
  "views",
  "shares",
  "saves",
] as const;

export const TESTABLE_POOL_TYPES = ["follower_test", "engagement_test"] as const;

// Prisma where-slice usable anywhere we need to query sellable
// services (testbot, scoring pre-filter, future audit endpoints).
// Intentionally NOT `as const` — Prisma's `in` expects mutable arrays
// on the type layer, and the values are frozen-by-convention anyway.
export const TESTABLE_WHERE: {
  active: true;
  platform: { in: string[] };
  serviceType: { in: string[] };
  poolType: { in: string[] };
  classificationManualReview: false;
} = {
  active: true,
  platform: { in: [...SELLABLE_PLATFORMS] },
  serviceType: { in: [...SELLABLE_SERVICE_TYPES] },
  poolType: { in: [...TESTABLE_POOL_TYPES] },
  classificationManualReview: false,
};

// In-memory equivalent for UI rendering. Takes the minimal set of
// fields a Service row must expose.
export function isTestableService(s: {
  active: boolean;
  platform: string;
  serviceType: string;
  poolType: string;
  classificationManualReview: boolean;
}): boolean {
  return (
    s.active &&
    (SELLABLE_PLATFORMS as readonly string[]).includes(s.platform) &&
    (SELLABLE_SERVICE_TYPES as readonly string[]).includes(s.serviceType) &&
    (TESTABLE_POOL_TYPES as readonly string[]).includes(s.poolType) &&
    !s.classificationManualReview
  );
}

// Human-readable reason a service is NOT testable — useful for
// tooltips and debug output. Returns null if the service IS testable.
export function whyNotTestable(s: {
  active: boolean;
  platform: string;
  serviceType: string;
  poolType: string;
  classificationManualReview: boolean;
}): string | null {
  if (!s.active) return "inactive";
  if (!(SELLABLE_PLATFORMS as readonly string[]).includes(s.platform))
    return `platform=${s.platform} non vendable`;
  if (!(SELLABLE_SERVICE_TYPES as readonly string[]).includes(s.serviceType))
    return `serviceType=${s.serviceType} non vendable`;
  if (s.classificationManualReview) return "en attente de triage manuel";
  if (!(TESTABLE_POOL_TYPES as readonly string[]).includes(s.poolType))
    return `poolType=${s.poolType}`;
  return null;
}
