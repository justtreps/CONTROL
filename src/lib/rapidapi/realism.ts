import type { InstagramFollower } from "./instagram";
import type { TikTokFollower } from "./tiktok";

export type RealismBreakdown = {
  picPct: number;
  bioPct: number;
  postPct: number;
  ratioPct: number | null;
  sampleSize: number;
};

export type RealismResult = {
  score: number;
  breakdown: RealismBreakdown;
};

const INSTA_DEFAULT_PIC_PATTERNS = [
  "464760996_1254146839119862_3605321457742435801_n.png",
  "anonymous_user",
];

function hasInstaCustomPic(url: string | undefined): boolean {
  if (!url) return false;
  return !INSTA_DEFAULT_PIC_PATTERNS.some((p) => url.includes(p));
}

function pct<T>(arr: readonly T[], predicate: (t: T) => boolean): number {
  if (arr.length === 0) return 0;
  return arr.filter(predicate).length / arr.length;
}

export function computeInstagramRealism(
  sample: readonly InstagramFollower[]
): RealismResult {
  const sampleSize = sample.length;
  if (sampleSize === 0) {
    return {
      score: 0,
      breakdown: { picPct: 0, bioPct: 0, postPct: 0, ratioPct: null, sampleSize: 0 },
    };
  }

  const picPct = pct(sample, (f) => hasInstaCustomPic(f.profile_pic_url));
  const bioPct = pct(sample, (f) => Boolean(f.full_name?.trim()));
  const postPct = pct(sample, (f) => !f.is_private);

  // Ratio not available from simple endpoint. Renormalize weights 0.35+0.25+0.25 = 0.85.
  const total = 0.35 + 0.25 + 0.25;
  const score = ((picPct * 0.35 + bioPct * 0.25 + postPct * 0.25) / total) * 100;

  return {
    score,
    breakdown: { picPct, bioPct, postPct, ratioPct: null, sampleSize },
  };
}

export function computeTikTokRealism(
  sample: readonly TikTokFollower[]
): RealismResult {
  const sampleSize = sample.length;
  if (sampleSize === 0) {
    return {
      score: 0,
      breakdown: { picPct: 0, bioPct: 0, postPct: 0, ratioPct: 0, sampleSize: 0 },
    };
  }

  const picPct = pct(
    sample,
    (f) => Boolean(f.avatar) && !f.avatar.toLowerCase().includes("default")
  );
  const bioPct = pct(sample, (f) => Boolean(f.signature?.trim()));
  const postPct = pct(sample, (f) => (f.aweme_count ?? 0) > 0);
  const ratioPct = pct(sample, (f) => {
    const fr = f.follower_count ?? 0;
    const fg = f.following_count ?? 0;
    if (fg <= 0) return false;
    const r = fr / fg;
    return r >= 0.1 && r <= 10;
  });

  const score =
    (picPct * 0.35 + bioPct * 0.25 + postPct * 0.25 + ratioPct * 0.15) * 100;

  return {
    score,
    breakdown: { picPct, bioPct, postPct, ratioPct, sampleSize },
  };
}
