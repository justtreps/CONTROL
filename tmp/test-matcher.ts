// Unit sanity check for the new matcher. Sample services from
// the BulkMedya feed with expected classification. Run before
// deploy to catch regressions on the user's reported problem
// cases.

import { matchAllProducts, matchService } from "../src/lib/catalogue/matcher";

const cases: Array<{
  name: string;
  platform: string;
  expect: string[]; // product slugs that should match
}> = [
  // User's reported positives
  {
    name: "Instagram Followers [ Max 10M ] | Real Active",
    platform: "instagram",
    expect: ["ig-followers"],
  },
  {
    name: "Instagram Views [Max 50M]",
    platform: "instagram",
    expect: ["ig-views"],
  },
  {
    name: "Instagram Likes [Quick Start]",
    platform: "instagram",
    expect: ["ig-likes"],
  },
  // User's reported negative — must NOT match ig-followers
  {
    name: "Instagram Channel Member",
    platform: "instagram",
    expect: [],
  },
  {
    name: "Instagram Broadcast Channel Subscribe",
    platform: "instagram",
    expect: [],
  },
  // Story likes must not hit ig-likes
  {
    name: "Instagram Story Likes",
    platform: "instagram",
    expect: [],
  },
  // Reel views → ig-views
  {
    name: "Instagram Reel Views 10k",
    platform: "instagram",
    expect: ["ig-views"],
  },
  // Video views → ig-views
  {
    name: "Instagram Video Views Max 1M",
    platform: "instagram",
    expect: ["ig-views"],
  },
  // Story views must NOT hit ig-views
  {
    name: "Instagram Story Views",
    platform: "instagram",
    expect: [],
  },
  // Live views must NOT hit ig-views
  {
    name: "Instagram Live Views",
    platform: "instagram",
    expect: [],
  },
  // Geo-tagged IG Followers (French emoji) → ig-followers + FR
  {
    name: "🇫🇷 Instagram Followers France [Max 500K]",
    platform: "instagram",
    expect: ["ig-followers"],
  },
  // TT samples
  {
    name: "TikTok Followers [Max 1M]",
    platform: "tiktok",
    expect: ["tt-followers"],
  },
  {
    name: "TikTok Live Followers",
    platform: "tiktok",
    expect: [], // live excluded
  },
  {
    name: "TikTok Views Video",
    platform: "tiktok",
    expect: ["tt-views"],
  },
  {
    name: "TikTok Ads Views",
    platform: "tiktok",
    expect: [], // ads excluded
  },
  {
    name: "TikTok Likes [Instant]",
    platform: "tiktok",
    expect: ["tt-likes"],
  },
  {
    name: "TikTok Shares [Fast]",
    platform: "tiktok",
    expect: ["tt-shares"],
  },
  {
    name: "TikTok Saves",
    platform: "tiktok",
    expect: ["tt-saves"],
  },
  {
    name: "TikTok Bookmark 5k",
    platform: "tiktok",
    expect: ["tt-saves"],
  },
  // Bot / fake / auto — must fail everything
  {
    name: "Instagram Bot Followers",
    platform: "instagram",
    expect: [],
  },
  {
    name: "Auto Instagram Likes",
    platform: "instagram",
    expect: [],
  },
];

let failed = 0;
for (const c of cases) {
  const got = matchAllProducts({
    id: 0,
    name: c.name,
    platform: c.platform,
    active: true,
  });
  const pass =
    got.length === c.expect.length &&
    got.every((g) => c.expect.includes(g));
  const marker = pass ? "✓" : "✗";
  console.log(
    `  ${marker}  [${c.platform}] "${c.name}"`
  );
  console.log(`       expect=${JSON.stringify(c.expect)}  got=${JSON.stringify(got)}`);
  if (!pass) failed++;
}

console.log(`\n  ${cases.length - failed}/${cases.length} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
