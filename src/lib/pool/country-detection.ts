// Detects the probable nationality of a scraped account from the
// follower-sample data we already have (no extra API call):
// fullName, biography (IG only — TT sample doesn't expose it),
// username.
//
// Returns ISO-3166 alpha-2 code + a confidence label. The testbot
// filters by `countryConfidence >= config.countryDetectionMinConfidence`
// so low-signal matches don't get routed to geo-targeted services
// unless the operator explicitly loosens the threshold.

export type CountryConfidence = "high" | "medium" | "low" | "unknown";

export type CountryDetection = {
  country: string | null;
  confidence: CountryConfidence;
};

// Emoji → ISO (kept in sync with classifier.ts — same map).
const FLAG_TO_ISO: Record<string, string> = {
  "🇫🇷": "FR", "🇧🇷": "BR", "🇺🇸": "US", "🇬🇧": "GB", "🇩🇪": "DE",
  "🇪🇸": "ES", "🇮🇹": "IT", "🇮🇳": "IN", "🇲🇽": "MX", "🇹🇷": "TR",
  "🇸🇦": "SA", "🇦🇪": "AE", "🇯🇵": "JP", "🇰🇷": "KR", "🇨🇳": "CN",
  "🇷🇺": "RU", "🇮🇩": "ID", "🇳🇬": "NG", "🇦🇷": "AR", "🇨🇴": "CO",
  "🇨🇱": "CL", "🇵🇪": "PE", "🇵🇹": "PT", "🇳🇱": "NL", "🇧🇪": "BE",
  "🇵🇱": "PL", "🇨🇦": "CA", "🇦🇺": "AU", "🇵🇭": "PH", "🇹🇭": "TH",
  "🇻🇳": "VN", "🇪🇬": "EG", "🇿🇦": "ZA", "🇮🇷": "IR", "🇵🇰": "PK",
  "🇧🇩": "BD", "🇲🇦": "MA", "🇩🇿": "DZ", "🇹🇳": "TN",
};

// City / country keywords in biography (lowercased match).
const BIO_KEYWORDS: Array<[RegExp, string]> = [
  [/\bparis\b|\blyon\b|\bmarseille\b|\btoulouse\b|\bnice\b|\bbordeaux\b|\blille\b|\bfrance\b/i, "FR"],
  [/\bsao paulo\b|\bs[ãa]o paulo\b|\brio de janeiro\b|\bbrasilia\b|\bbrasil\b|\bbrazil\b/i, "BR"],
  [/\bnew york\b|\bnyc\b|\bla\b\s*(?:california|usa)|\blos angeles\b|\bmiami\b|\bchicago\b|\busa\b|\bunited states\b/i, "US"],
  [/\blondon\b|\bmanchester\b|\bbirmingham\b|\bliverpool\b|\buk\b/i, "GB"],
  [/\bberlin\b|\bmunich\b|\bm[üu]nchen\b|\bhamburg\b|\bfrankfurt\b|\bdeutschland\b|\bgermany\b/i, "DE"],
  [/\bmadrid\b|\bbarcelona\b|\bvalencia\b|\bsevilla\b|\bespa[ñn]a\b|\bspain\b/i, "ES"],
  [/\broma\b|\brome\b|\bmilano\b|\bmilan\b|\bnapoli\b|\bitalia\b|\bitaly\b/i, "IT"],
  [/\bmumbai\b|\bdelhi\b|\bbangalore\b|\bkolkata\b|\bchennai\b|\bindia\b/i, "IN"],
  [/\bmexico\b|\bcdmx\b|\bguadalajara\b|\bmonterrey\b/i, "MX"],
  [/\bistanbul\b|\bankara\b|\bizmir\b|\bt[üu]rkiye\b|\bturkey\b/i, "TR"],
  [/\briyadh\b|\bjeddah\b|\bdubai\b|\babu dhabi\b|\bdoha\b/i, "SA"],
  [/\btokyo\b|\bosaka\b|\bkyoto\b|\bjapan\b/i, "JP"],
  [/\bseoul\b|\bkorea\b/i, "KR"],
  [/\bshanghai\b|\bbeijing\b|\bchina\b/i, "CN"],
  [/\bmoscow\b|\bmoskva\b|\bst petersburg\b|\bspb\b/i, "RU"],
  [/\bjakarta\b|\bbandung\b|\bsurabaya\b|\bindonesia\b/i, "ID"],
  [/\blagos\b|\babuja\b|\bnigeria\b/i, "NG"],
  [/\bbuenos aires\b|\bargentina\b/i, "AR"],
  [/\bbogot[áa]\b|\bmedell[ií]n\b|\bcolombia\b/i, "CO"],
  [/\bsantiago\b|\bchile\b/i, "CL"],
  [/\blima\b|\bper[úu]\b/i, "PE"],
  [/\blisboa\b|\bporto\b|\bportugal\b/i, "PT"],
  [/\bamsterdam\b|\brotterdam\b|\bnetherlands\b|\bholland\b/i, "NL"],
  [/\bbrussels\b|\bbruxelles\b|\bbelgium\b|\bbelgique\b/i, "BE"],
  [/\bwarsaw\b|\bwarszawa\b|\bkrakow\b|\bpoland\b/i, "PL"],
  [/\btoronto\b|\bvancouver\b|\bmontreal\b|\bcanada\b/i, "CA"],
  [/\bsydney\b|\bmelbourne\b|\bbrisbane\b|\baustralia\b/i, "AU"],
  [/\bmanila\b|\bphilippines\b/i, "PH"],
  [/\bbangkok\b|\bthailand\b/i, "TH"],
  [/\bhanoi\b|\bsaigon\b|\bho chi minh\b|\bvietnam\b/i, "VN"],
  [/\bcairo\b|\balexandria\b|\begypt\b/i, "EG"],
  [/\bcape town\b|\bjohannesburg\b|\bsouth africa\b/i, "ZA"],
  [/\btehran\b|\biran\b/i, "IR"],
  [/\bkarachi\b|\blahore\b|\bpakistan\b/i, "PK"],
  [/\bdhaka\b|\bbangladesh\b/i, "BD"],
  [/\bcasablanca\b|\brabat\b|\bmarrakech\b|\bmaroc\b|\bmorocco\b/i, "MA"],
  [/\balger\b|\balgeria\b|\balg[ée]rie\b/i, "DZ"],
  [/\btunis\b|\btunisie\b|\btunisia\b/i, "TN"],
];

// Username affix hints (.fr, _br, paris_, etc.). Medium confidence.
const USERNAME_AFFIX: Array<[RegExp, string]> = [
  [/(?:^|[_.])fr(?:[_.]|$)/i, "FR"],
  [/(?:^|[_.])br(?:[_.]|$)/i, "BR"],
  [/(?:^|[_.])usa?(?:[_.]|$)/i, "US"],
  [/(?:^|[_.])uk(?:[_.]|$)/i, "GB"],
  [/(?:^|[_.])de(?:[_.]|$)/i, "DE"],
  [/(?:^|[_.])es(?:[_.]|$)/i, "ES"],
  [/(?:^|[_.])it(?:[_.]|$)/i, "IT"],
  [/(?:^|[_.])in(?:[_.]|$)/i, "IN"],
  [/(?:^|[_.])mx(?:[_.]|$)/i, "MX"],
  [/(?:^|[_.])tr(?:[_.]|$)/i, "TR"],
  [/paris|lyon|marseille|bordeaux|lille|toulouse/i, "FR"],
  [/\bsao ?paulo\b|\brio\b|\bbrasil\b/i, "BR"],
  [/london|nyc|usa/i, "US"],
  [/berlin|munich|hamburg/i, "DE"],
  [/madrid|barcelona|valencia/i, "ES"],
  [/roma|milano|napoli/i, "IT"],
];

// Very small cultural first-name dictionary for low-signal inference
// when we have a full name and nothing stronger. Intentionally
// minimal — precision over recall; we'd rather return null than
// mis-tag an account.
const FIRST_NAME_HINTS: Array<[RegExp, string]> = [
  [/\b(pierre|jean|fran[çc]ois|am[ée]lie|claire|camille|l[ée]a|hugo|juliette|th[ée]o|manon|mathieu|antoine|charlotte|laurent|nathalie)\b/i, "FR"],
  [/\b(jo[ãa]o|pedro|rafael|lucas|gabriel|matheus|mariana|juliana|let[íi]cia|beatriz|rafaela|camila|larissa|ana paula)\b/i, "BR"],
  [/\b(jessica|jennifer|michael|christopher|ashley|brandon|amanda|tyler|brittany|dakota|jacob|madison)\b/i, "US"],
  [/\b(francesco|giuseppe|marco|luca|giulia|francesca|chiara|martina|alessandro|matteo|valentina)\b/i, "IT"],
  [/\b(jos[ée]|juan|carlos|mar[íi]a|ana|laura|patricia|alejandro|javier|cristina|rosa|manuel)\b/i, "ES"],
  [/\b(hans|klaus|dieter|petra|andrea|stefan|j[üu]rgen|sebastian|nadine|wolfgang)\b/i, "DE"],
];

export function detectAccountCountry({
  fullName,
  biography,
  username,
}: {
  fullName?: string | null;
  biography?: string | null;
  username?: string | null;
}): CountryDetection {
  const name = fullName ?? "";
  const bio = biography ?? "";
  const u = username ?? "";
  const combined = `${name} ${bio}`;

  // Tier 1 — emoji flag (highest confidence). Searches both fullName
  // and biography.
  for (const [emoji, iso] of Object.entries(FLAG_TO_ISO)) {
    if (combined.includes(emoji)) return { country: iso, confidence: "high" };
  }

  // Tier 2 — bio / fullName keyword (medium).
  for (const [rx, iso] of BIO_KEYWORDS) {
    if (rx.test(combined)) return { country: iso, confidence: "medium" };
  }

  // Tier 3 — username affix (medium).
  for (const [rx, iso] of USERNAME_AFFIX) {
    if (rx.test(u)) return { country: iso, confidence: "medium" };
  }

  // Tier 4 — first-name cultural hint (low).
  for (const [rx, iso] of FIRST_NAME_HINTS) {
    if (rx.test(name)) return { country: iso, confidence: "low" };
  }

  return { country: null, confidence: "unknown" };
}
