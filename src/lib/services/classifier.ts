// Classifies BulkMedya service rows into one of 4 verdicts:
//   • follower   — goes into poolType='follower_test', active=true, manualReview=false
//   • engagement — goes into poolType='engagement_test', active=true, manualReview=false
//   • manual     — active=true, manualReview=true (operator triages in /config/services-review)
//   • disabled   — active=false (hard reject: we don't sell this and probably never will)
//
// Design principle: STRICT WHITELIST. We only match clean, unambiguous
// service names against a small set of allowed types per platform.
// Every other wording (story likes, reel views, impressions, comments,
// autoplays, polls, mentions, igtv, live viewers, profile visits…)
// goes to `disabled` directly so scoring + routing don't waste cycles
// on services we'll never dispatch. Ambiguous adjectives (real views,
// hq views, premium views) + platform-specific oddities get
// `manual` so the operator gets the final say.
//
// Runs on every new sync row AND on every existing row when the
// operator triggers /api/pool/reclassify-services. Idempotent.

export type PoolType = "follower_test" | "engagement_test" | "unknown";

export type ClassificationVerdict =
  | "follower"
  | "engagement"
  | "manual"
  | "disabled";

export type ClassifyResult = {
  verdict: ClassificationVerdict;
  poolType: PoolType;
  targetCountry: string | null;
  active: boolean;
  classificationManualReview: boolean;
};

// ── Keyword families (used below in strict order) ───────────────────

// Hard-reject topics — BulkMedya sells these but the user explicitly
// doesn't want any of them on the router. Matched FIRST so that e.g.
// "Instagram Story Views" never slips through the `views` whitelist.
// Every token handles singular + plural via `s?` (except
// already-explicit alternations like story|stories). If you forget
// the `s?` you get a subtle bug where "Reposts" sneaks through as
// engagement because SHARES_RX catches it before DISABLE does.
const DISABLE_TOPIC_RX =
  /\b(stor(?:y|ies)|igtv|instagram\s+tv|ig\s*tv|livestreams?|live\s*stream(?:ing)?|live\s*stream\s*(?:views?|viewers?)|live\s*viewers?|live\s*views?|live\s*chat|impressions?|reach(?:es)?|profile\s*visits?|mentions?|autoplays?|reposts?|reposte[rs]?|poll(?:s|es)?|votes?|quiz(?:z?es)?|reactions?|comment(?:s|aire[s]?)?)\b/i;

// "Reel / video / story + likes/views" variants — Amir wants these
// flagged for manual review (not auto-disabled) because a minority
// might be worth enabling after he looks at them.
const REEL_VIDEO_VARIANT_RX =
  /\b(reels?|videos?|story|stories|igtv|live)\s+(likes?|views?|plays?)\b/i;

// Adjectival noise ("real views", "hq views", "premium likes", etc.)
// — ambiguous marketing language. Manual review.
const AMBIGUOUS_ADJ_RX =
  /\b(real|hq|high\s*quality|premium|ultra|mega|vip)\s+(likes?|views?)\b/i;

// Suspicious follower wordings — "bot followers", "fake followers",
// "real followers bot" (a real BulkMedya variant). Manual review.
const FOLLOWER_SUSPICIOUS_RX =
  /\b(bot\s+followers?|fake\s+followers?|real\s+followers?\s+bot)\b/i;

// Suspicious engagement wordings — same idea but applied to likes +
// views. Bot/fake quality markers are a quality-signal risk; operator
// should decide whether to keep them.
const ENGAGEMENT_SUSPICIOUS_RX =
  /\b(bot\s+(likes?|views?)|fake\s+(likes?|views?))\b/i;

// Whitelist keyword tests — strict \b boundaries so "viewers" /
// "likewise" / similar false positives don't match.
const FOLLOWERS_RX = /\b(followers?|abonn[eé]es?|subscribers?|subs)\b/i;
const LIKES_RX = /\b(likes?|j'aimes?)\b/i;
const VIEWS_RX = /\b(views?|vues?|visionnages?|plays?)\b/i;
// Shares — note: reposts/reposte are NOT aliased to shares here.
// Amir explicitly flagged them as DISABLE, and DISABLE_TOPIC_RX
// catches them above before we ever reach the engagement whitelist.
const SHARES_RX = /\b(shares?|partages?)\b/i;
const SAVES_RX =
  /\b(saves?|sauvegardes?|enregistrements?|bookmarks?|favou?rites?)\b/i;

const SUPPORTED_PLATFORMS = new Set(["instagram", "tiktok"]);

// ── Public API ──────────────────────────────────────────────────────

export type ClassifyInput = {
  name: string;
  platform: string;
};

export function classifyService(input: ClassifyInput): ClassifyResult {
  const { name, platform } = input;
  const verdict = decideVerdict({ name, platform });
  const targetCountry = detectCountry(name);

  switch (verdict) {
    case "follower":
      return {
        verdict,
        poolType: "follower_test",
        targetCountry,
        active: true,
        classificationManualReview: false,
      };
    case "engagement":
      return {
        verdict,
        poolType: "engagement_test",
        targetCountry,
        active: true,
        classificationManualReview: false,
      };
    case "manual":
      return {
        verdict,
        poolType: "unknown",
        targetCountry,
        active: true,
        classificationManualReview: true,
      };
    case "disabled":
      return {
        verdict,
        poolType: "unknown",
        targetCountry,
        active: false,
        classificationManualReview: false,
      };
  }
}

function decideVerdict({
  name,
  platform,
}: {
  name: string;
  platform: string;
}): ClassificationVerdict {
  // Platform gate — we only support IG + TT. Everything else is out
  // of scope for the router.
  if (!SUPPORTED_PLATFORMS.has(platform)) return "disabled";

  const s = name.toLowerCase();

  // 1. Hard-disable topics — checked FIRST so story/comment/reach
  //    variants never slip past the whitelist below.
  if (DISABLE_TOPIC_RX.test(s)) return "disabled";

  // 2. Follower path — strict word match + suspicious-variant triage.
  if (FOLLOWERS_RX.test(s)) {
    if (FOLLOWER_SUSPICIOUS_RX.test(s)) return "manual";
    return "follower";
  }

  // 3. Ambiguous wording (reel likes / video views / story plays /
  //    real views / hq views / bot likes …) → manual review.
  if (REEL_VIDEO_VARIANT_RX.test(s)) return "manual";
  if (AMBIGUOUS_ADJ_RX.test(s)) return "manual";
  if (ENGAGEMENT_SUSPICIOUS_RX.test(s)) return "manual";

  // 4. Engagement whitelist per platform.
  //    Instagram: likes + views only.
  //    TikTok: likes + views + shares + saves/favorites/bookmarks.
  if (platform === "instagram") {
    if (LIKES_RX.test(s)) return "engagement";
    if (VIEWS_RX.test(s)) return "engagement";
  } else if (platform === "tiktok") {
    if (LIKES_RX.test(s)) return "engagement";
    if (VIEWS_RX.test(s)) return "engagement";
    if (SHARES_RX.test(s)) return "engagement";
    if (SAVES_RX.test(s)) return "engagement";
  }

  // 5. Nothing matched — safer to flag for manual review than to
  //    silently drop. Operator will either enable or disable.
  return "manual";
}

// ── targetCountry (unchanged) ───────────────────────────────────────
// Three signal tiers, strongest first:
//   1. Emoji flags in the service name (🇫🇷 / 🇧🇷 / ...)
//   2. Explicit ISO code surrounded by punctuation: (FR) / - BR / _US
//   3. Country/region keyword (france / brazil / usa / ...)

const FLAG_TO_ISO: Record<string, string> = {
  "🇫🇷": "FR",
  "🇧🇷": "BR",
  "🇺🇸": "US",
  "🇬🇧": "GB",
  "🇩🇪": "DE",
  "🇪🇸": "ES",
  "🇮🇹": "IT",
  "🇮🇳": "IN",
  "🇲🇽": "MX",
  "🇹🇷": "TR",
  "🇸🇦": "SA",
  "🇦🇪": "AE",
  "🇯🇵": "JP",
  "🇰🇷": "KR",
  "🇨🇳": "CN",
  "🇷🇺": "RU",
  "🇮🇩": "ID",
  "🇳🇬": "NG",
  "🇦🇷": "AR",
  "🇨🇴": "CO",
  "🇨🇱": "CL",
  "🇵🇪": "PE",
  "🇵🇹": "PT",
  "🇳🇱": "NL",
  "🇧🇪": "BE",
  "🇵🇱": "PL",
  "🇨🇦": "CA",
  "🇦🇺": "AU",
  "🇵🇭": "PH",
  "🇹🇭": "TH",
  "🇻🇳": "VN",
  "🇪🇬": "EG",
  "🇿🇦": "ZA",
  "🇮🇷": "IR",
  "🇵🇰": "PK",
  "🇧🇩": "BD",
  "🇲🇦": "MA",
  "🇩🇿": "DZ",
  "🇹🇳": "TN",
  "🇨🇭": "CH",
  "🇸🇪": "SE",
  "🇳🇴": "NO",
  "🇩🇰": "DK",
  "🇫🇮": "FI",
  "🇬🇷": "GR",
  "🇮🇱": "IL",
  "🇺🇦": "UA",
};

const KEYWORDS: Array<[RegExp, string]> = [
  [/\bfrance\b|\bfrancais\b|\bfrench\b/i, "FR"],
  [/\bbrazil\b|\bbrasil\b|\bbrazilian\b/i, "BR"],
  [/\busa\b|\bus-america\b|\bamerican\b|\bunited states\b/i, "US"],
  [/\buk\b|\bunited kingdom\b|\bbritish\b|\bengland\b/i, "GB"],
  [/\bgermany\b|\bdeutschland\b|\bgerman\b/i, "DE"],
  [/\bspain\b|\bespa[ñn]a\b|\bspanish\b/i, "ES"],
  [/\bitaly\b|\bitalia\b|\bitalian\b/i, "IT"],
  [/\bindia\b|\bindian\b/i, "IN"],
  [/\bmexico\b|\bmexican\b/i, "MX"],
  [/\bturkey\b|\bt[üu]rkiye\b|\bturkish\b/i, "TR"],
  [/\barab\b|\bgulf\b|\bsaudi\b/i, "SA"],
  [/\buae\b|\bemirates\b/i, "AE"],
  [/\bjapan\b|\bjapanese\b/i, "JP"],
  [/\bkorea\b|\bkorean\b/i, "KR"],
  [/\bchina\b|\bchinese\b/i, "CN"],
  [/\brussia\b|\brussian\b/i, "RU"],
  [/\bindonesia\b|\bindonesian\b/i, "ID"],
  [/\bnigeria\b|\bnigerian\b/i, "NG"],
  [/\bargentin[ao]\b/i, "AR"],
  [/\bcolombia\b/i, "CO"],
  [/\bchile\b|\bchilean\b/i, "CL"],
  [/\bperu\b|\bperuvian\b/i, "PE"],
  [/\bportug(al|uese)\b/i, "PT"],
  [/\bnetherlands\b|\bdutch\b/i, "NL"],
  [/\bbelgi(an|um|que)\b/i, "BE"],
  [/\bpoland\b|\bpolish\b/i, "PL"],
  [/\bcanada\b|\bcanadian\b/i, "CA"],
  [/\baustrali[an]*\b/i, "AU"],
  [/\bphilippines\b|\bfilipino\b/i, "PH"],
  [/\bthailand\b|\bthai\b/i, "TH"],
  [/\bvietnam\b|\bvietnamese\b/i, "VN"],
  [/\begypt\b|\begyptian\b/i, "EG"],
  [/\bsouth africa\b|\bsouth-african\b/i, "ZA"],
  [/\biran\b|\biranian\b/i, "IR"],
  [/\bpakistan\b|\bpakistani\b/i, "PK"],
  [/\bbangladesh\b|\bbengali\b/i, "BD"],
  [/\bmorocco\b|\bmoroccan\b/i, "MA"],
  [/\balgeri[an]*\b/i, "DZ"],
  [/\btunisi[an]*\b/i, "TN"],
];

const ISO_CODE_RX =
  /[\s([_\-\][](FR|BR|US|GB|UK|DE|ES|IT|IN|MX|TR|SA|AE|JP|KR|CN|RU|ID|NG|AR|CO|CL|PE|PT|NL|BE|PL|CA|AU|PH|TH|VN|EG|ZA|IR|PK|BD|MA|DZ|TN|CH|SE|NO|DK|FI|GR|IL|UA)[\s)\]_\-\][]/;

const NEGATIVES_RX =
  /\bworldwide\b|\bglobal\b|\binternational\b|\breal users?\b/i;

export function detectCountry(serviceName: string): string | null {
  // 1. Emoji flag — highest-signal
  for (const [emoji, iso] of Object.entries(FLAG_TO_ISO)) {
    if (serviceName.includes(emoji)) return iso;
  }
  // 2. Explicit ISO code marker
  const isoMatch = serviceName.match(ISO_CODE_RX);
  if (isoMatch) {
    const raw = isoMatch[1].toUpperCase();
    return raw === "UK" ? "GB" : raw;
  }
  // 3. Keyword
  for (const [rx, iso] of KEYWORDS) {
    if (rx.test(serviceName)) return iso;
  }
  // 4. Explicit global/worldwide — null
  if (NEGATIVES_RX.test(serviceName)) return null;
  return null;
}
