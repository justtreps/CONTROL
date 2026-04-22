// Classifies BulkMedya service names into (poolType, targetCountry).
// Runs once on every service during the migration and on every new
// service as it's synced from BulkMedya.
//
// Keep it simple regex-based — false positives are OK (user can
// triage via /config/services-review), false negatives just flag
// for manual review.

// ── poolType ─────────────────────────────────────────────────────────
// Word boundaries on the lowercased service name. Order matters:
// comment/story/igtv are matched FIRST because those services exist
// in BulkMedya but we don't sell them, so we explicitly bucket them
// as 'unknown' + manual review rather than mis-classifying them as
// engagement.
const FOLLOWER_RX =
  /\b(follower|followers|subscriber|subscribers|abonne|abonnes|abonné|abonnés|subs)\b/i;
const ENGAGEMENT_RX =
  /\b(like|likes|view|views|vue|vues|share|shares|partage|partages|save|saves|enregistrement|enregistrements|impression|impressions|reach|plays|reads)\b/i;
const SKIP_RX =
  /\b(comment|comments|commentaire|commentaires|story|stories|igtv|reel\s*view|video\s*view|dm\b|direct|live\s*view)\b/i;

export type PoolType = "follower_test" | "engagement_test" | "unknown";

export function detectPoolType(serviceName: string): PoolType {
  const s = serviceName.toLowerCase();
  if (SKIP_RX.test(s)) return "unknown";
  if (FOLLOWER_RX.test(s)) return "follower_test";
  if (ENGAGEMENT_RX.test(s)) return "engagement_test";
  return "unknown";
}

// ── targetCountry ───────────────────────────────────────────────────
// Returns an ISO-3166 alpha-2 code or null (global service). Three
// signal tiers, strongest first:
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

// Keyword → ISO. Keep the keyword map below written in lowercase.
// Matching requires a word-boundary so "france" matches but
// "freelance" doesn't.
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

// Fast ISO code detection: look for (XX) / - XX / _XX / [XX]
const ISO_CODE_RX = /[\s([_\-\][](FR|BR|US|GB|UK|DE|ES|IT|IN|MX|TR|SA|AE|JP|KR|CN|RU|ID|NG|AR|CO|CL|PE|PT|NL|BE|PL|CA|AU|PH|TH|VN|EG|ZA|IR|PK|BD|MA|DZ|TN|CH|SE|NO|DK|FI|GR|IL|UA)[\s)\]_\-\][]/;

const NEGATIVES_RX = /\bworldwide\b|\bglobal\b|\binternational\b|\breal users?\b/i;

export function detectCountry(serviceName: string): string | null {
  // 1. Emoji flag — highest-signal
  for (const [emoji, iso] of Object.entries(FLAG_TO_ISO)) {
    if (serviceName.includes(emoji)) return iso;
  }

  // 2. Explicit ISO code marker
  const isoMatch = serviceName.match(ISO_CODE_RX);
  if (isoMatch) {
    const raw = isoMatch[1].toUpperCase();
    return raw === "UK" ? "GB" : raw; // normalize UK → GB
  }

  // 3. Keyword
  for (const [rx, iso] of KEYWORDS) {
    if (rx.test(serviceName)) return iso;
  }

  // 4. Explicit global/worldwide — null
  if (NEGATIVES_RX.test(serviceName)) return null;

  return null;
}

// Combined classifier — returns everything we want to write to the
// Service row.
export function classifyService(serviceName: string): {
  poolType: PoolType;
  targetCountry: string | null;
  classificationManualReview: boolean;
} {
  const poolType = detectPoolType(serviceName);
  const targetCountry = detectCountry(serviceName);
  // 'unknown' poolType means the name didn't match any pattern OR it
  // matched a SKIP bucket (comment / story / ...) — either way flag
  // for review.
  const classificationManualReview = poolType === "unknown";
  return { poolType, targetCountry, classificationManualReview };
}
