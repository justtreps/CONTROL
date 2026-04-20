// Hardcoded seed pool for the /api/pool/seeds/suggestions endpoint.
// The UI pulls N unused names from these lists so an operator can
// scale the seed count in one click instead of hand-typing handles.
//
// Rule of thumb: top-tier accounts with broad, international audiences
// tend to produce follower lists with lots of near-virgin spam accounts
// — which is exactly what the pool wants to ingest.

export const SUGGESTED_INSTAGRAM_SEEDS: string[] = [
  // People — music / pop culture
  "selenagomez",
  "justinbieber",
  "shakira",
  "jlo",
  "badbunnypr",
  "kendalljenner",
  "khloekardashian",
  "zendaya",
  "billieeilish",
  "dualipa",
  "kourtneykardash",
  "champagnepapi",
  "cardib",
  "nickiminaj",
  "drake",
  "theweeknd",
  "postmalone",
  "travisscott",
  "snoopdogg",
  "50cent",
  "eminem",
  "katyperry",
  "rihanna",
  "chrisbrownofficial",
  "kevinhart4real",
  "willsmith",
  // People — sports / athletes
  "neymarjr",
  "virat.kohli",
  "kingjames",
  "davidbeckham",
  "zacefron",
  // People — models / influencers
  "gigihadid",
  "bellahadid",
  "mirandakerr",
  "candiceswanepoel",
  "karliekloss",
  "adrianalima",
  "chiaraferragni",
  "priyankachopra",
  "emmawatson",
  // Brands — media
  "natgeo",
  "nba",
  "netflix",
  "disneyplus",
  "hboofficial",
  "primevideo",
  "spotify",
  "applemusic",
  // Brands — fashion / luxury
  "louisvuitton",
  "chanelofficial",
  "gucci",
  "prada",
  "versace",
  "dior",
  "fendi",
  // Brands — teams
  "real_madrid",
  "fcbarcelona",
  // Brands — auto
  "bmw",
  "mercedesbenz",
  "ferrari",
  "lamborghini",
  "ducati",
  "harleydavidson",
];

export const SUGGESTED_TIKTOK_SEEDS: string[] = [
  // Creators — top tier
  "spencerx",
  "michaelle",
  "dixiedamelio",
  "jamescharles",
  "lorengray",
  "tiktok",
  "lilhuddy",
  "jasonderulo",
  "gordonramsayofficial",
  "tessemarie",
  "noahbeck",
  "willsmith",
  "chriskhouri",
  "avani",
  "brittanybroski",
  "markdacascos",
  "itsjojosiwa",
  "babyariel",
  "joshrichards",
  "anthonyreeves",
  "payton",
  "chase.hudson",
  "jayus",
  "zoelaverne",
  "carolinaharo",
  "lizakoshy",
  "bach.ac",
  "derek.rosa",
  // Crossover artists
  "selenagomez",
  "rihanna",
  "snoopdogg",
  "iambeckyg",
  "ashnikko",
  "bryceXhall",
  "lilnasx",
];

export function suggestedSeedsFor(platform: string): string[] {
  if (platform === "instagram") return SUGGESTED_INSTAGRAM_SEEDS;
  if (platform === "tiktok") return SUGGESTED_TIKTOK_SEEDS;
  return [];
}
