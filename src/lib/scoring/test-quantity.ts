// Test-placement quantity helper.
//
// Some BulkMedya SKUs have minQuantity = 1 (or 5, or 10). At those
// sizes the provider often doesn't dispatch at all, or the
// delivery noise floor is bigger than the signal — RapidAPI can't
// tell whether 3 followers came from BulkMedya or from a random
// organic spike.
//
// Floor at 20 so every test exercises a measurable amount. If a
// service's maxQuantity is below 20 (rare — usually a corrupt
// BulkMedya row), testQuantityFor returns null so the caller can
// skip the placement entirely.

export const TEST_QUANTITY_FLOOR = 20;

export function testQuantityFor(service: {
  minQuantity: number;
  maxQuantity: number;
}): number | null {
  const q = Math.max(TEST_QUANTITY_FLOOR, service.minQuantity);
  if (service.maxQuantity > 0 && q > service.maxQuantity) return null;
  return q;
}

// Same logic but cost-aware — used by campaign launchers + the
// auto-place phase to compute the per-test cost using the
// floored quantity instead of the raw min.
export function testCostUsd(service: {
  ratePerK: number;
  minQuantity: number;
  maxQuantity: number;
}): number | null {
  const q = testQuantityFor(service);
  if (q === null) return null;
  return (service.ratePerK * q) / 1000;
}
