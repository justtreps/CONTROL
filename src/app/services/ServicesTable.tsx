"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ScoreBadge } from "@/components/ScoreBadge";
import { Sparkline } from "@/components/Sparkline";

export type ServiceRow = {
  id: number;
  bulkmedyaId: number;
  name: string;
  category: string;
  platform: string;
  serviceType: string;
  ratePerK: number;
  minQuantity: number;
  maxQuantity: number;
  refillSupported: boolean;
  testOrderCount: number;
  currentScore: number | null;
  completionFactor: number | null;
  realismScore: number | null;
  speedScore: number | null;
  dropScore: number | null;
  history: number[];
  // Classification fields (set by /api/pool/reclassify-services OR
  // manual triage on /config/services-review)
  poolType: string;
  targetCountry: string | null;
  classificationManualReview: boolean;
};

type SortKey = "score" | "name" | "rate" | "orders";
type PoolFilter =
  | "all"
  | "follower_test"
  | "engagement_test"
  | "manual_review"
  | "unknown";

const FILTER_INPUT =
  "interactive bg-transparent border border-[#666666]/30 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

// Emoji → ISO map. Reused from PoolAccountsList / PoolStatsHero so
// flags render consistently across the app.
const COUNTRY_FLAGS: Record<string, string> = {
  FR: "🇫🇷", BR: "🇧🇷", US: "🇺🇸", GB: "🇬🇧", DE: "🇩🇪",
  ES: "🇪🇸", IT: "🇮🇹", IN: "🇮🇳", MX: "🇲🇽", TR: "🇹🇷",
  SA: "🇸🇦", AE: "🇦🇪", JP: "🇯🇵", KR: "🇰🇷", CN: "🇨🇳",
  RU: "🇷🇺", ID: "🇮🇩", NG: "🇳🇬", AR: "🇦🇷", CO: "🇨🇴",
  CL: "🇨🇱", PE: "🇵🇪", PT: "🇵🇹", NL: "🇳🇱", BE: "🇧🇪",
  PL: "🇵🇱", CA: "🇨🇦", AU: "🇦🇺", PH: "🇵🇭", TH: "🇹🇭",
  VN: "🇻🇳", EG: "🇪🇬", ZA: "🇿🇦", IR: "🇮🇷", PK: "🇵🇰",
  BD: "🇧🇩", MA: "🇲🇦", DZ: "🇩🇿", TN: "🇹🇳",
};

export function ServicesTable({ rows }: { rows: ServiceRow[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [poolFilter, setPoolFilter] = useState<PoolFilter>("all");
  const [countryFilter, setCountryFilter] = useState("all");

  // Build the country dropdown options from what's actually in the
  // current result set so we don't list 40 empty ISO codes.
  const countriesInData = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.targetCountry) set.add(r.targetCountry);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q)
      );
    }

    if (poolFilter !== "all") {
      out = out.filter((r) => {
        if (poolFilter === "manual_review") return r.classificationManualReview;
        if (poolFilter === "unknown")
          return r.poolType === "unknown" && !r.classificationManualReview;
        return r.poolType === poolFilter;
      });
    }

    if (countryFilter !== "all") {
      out = out.filter((r) =>
        countryFilter === "global"
          ? r.targetCountry === null
          : r.targetCountry === countryFilter
      );
    }

    const sorted = [...out];
    sorted.sort((a, b) => {
      if (sort === "score") {
        const av = a.currentScore ?? -1;
        const bv = b.currentScore ?? -1;
        return bv - av;
      }
      if (sort === "rate") return a.ratePerK - b.ratePerK;
      if (sort === "orders") return b.testOrderCount - a.testOrderCount;
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [rows, query, sort, poolFilter, countryFilter]);

  return (
    <>
      {/* Filters bar — search + pool type + country + sort */}
      <div className="flex flex-wrap gap-3 px-4 md:px-6 py-4 border-b border-[#666666]/20 bg-[#0D0D0D]">
        <input
          placeholder="RECHERCHER..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${FILTER_INPUT} w-full sm:w-64`}
        />
        <select
          value={poolFilter}
          onChange={(e) => setPoolFilter(e.target.value as PoolFilter)}
          className={FILTER_INPUT}
          aria-label="Type de pool"
        >
          <option value="all">TOUS TYPES</option>
          <option value="follower_test">ABONNÉS</option>
          <option value="engagement_test">ENGAGEMENT</option>
          <option value="manual_review">MANUEL (À TRANCHER)</option>
          <option value="unknown">IGNORÉS</option>
        </select>
        <select
          value={countryFilter}
          onChange={(e) => setCountryFilter(e.target.value)}
          className={FILTER_INPUT}
          aria-label="Pays ciblé"
        >
          <option value="all">TOUS PAYS</option>
          <option value="global">GLOBAL</option>
          {countriesInData.map((iso) => (
            <option key={iso} value={iso}>
              {COUNTRY_FLAGS[iso] ?? ""} {iso}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className={`${FILTER_INPUT} sm:ml-auto`}
        >
          <option value="score">TRI : SCORE</option>
          <option value="name">TRI : NOM</option>
          <option value="rate">TRI : TARIF</option>
          <option value="orders">TRI : NB TESTS</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-xs uppercase tracking-widest">
            <tr className="border-b border-[#666666]/20">
              <th className="text-left px-4 py-3 font-normal">Service</th>
              <th className="text-left px-3 py-3 font-normal">Plat.</th>
              <th className="text-left px-3 py-3 font-normal">Type</th>
              <th className="text-center px-3 py-3 font-normal">Score</th>
              <th className="text-left px-3 py-3 font-normal">Tendance</th>
              <th className="text-center px-3 py-3 font-normal">Livr.</th>
              <th className="text-center px-3 py-3 font-normal">Réal.</th>
              <th className="text-center px-3 py-3 font-normal">Vit.</th>
              <th className="text-center px-3 py-3 font-normal">Drop</th>
              <th className="text-right px-3 py-3 font-normal">Tarif/k</th>
              <th className="text-right px-3 py-3 font-normal">Min</th>
              <th className="text-right px-3 py-3 font-normal">Tests</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.id}
                className="interactive border-b border-[#666666]/20 hover:bg-[#0D0D0D] hover:border-l-2 hover:border-l-[#FF3300] transition-all duration-200"
              >
                <td className="px-4 py-3 max-w-xs">
                  <Link
                    href={`/services/${r.id}`}
                    className="block brand font-display text-sm uppercase tracking-tight text-white truncate"
                    title={`${r.name} [#${r.bulkmedyaId}]`}
                  >
                    {r.name}
                  </Link>
                  <div
                    className="font-mono text-xs text-[#666666] tracking-widest uppercase truncate mt-1"
                    title={r.category}
                  >
                    <span className="text-[#FF3300]/80">#{r.bulkmedyaId}</span>
                    <span className="mx-2 text-[#666666]/40">·</span>
                    {r.category}
                  </div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <PoolBadge row={r} />
                    <CountryBadge code={r.targetCountry} />
                  </div>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                  {r.platform}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-[#666666] uppercase tracking-widest">
                  {r.serviceType}
                </td>
                <td className="px-3 py-3 text-center">
                  <ScoreBadge score={r.currentScore} />
                </td>
                <td className="px-3 py-3">
                  <Sparkline values={r.history} />
                </td>
                <td className="px-3 py-3 text-center">
                  <ScoreBadge
                    score={
                      r.completionFactor !== null
                        ? r.completionFactor * 100
                        : null
                    }
                    size="sm"
                  />
                </td>
                <td className="px-3 py-3 text-center">
                  <ScoreBadge score={r.realismScore} size="sm" />
                </td>
                <td className="px-3 py-3 text-center">
                  <ScoreBadge score={r.speedScore} size="sm" />
                </td>
                <td className="px-3 py-3 text-center">
                  <ScoreBadge score={r.dropScore} size="sm" />
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-white tabular-nums">
                  {r.ratePerK.toFixed(2)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums">
                  {r.minQuantity}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs text-[#666666] tabular-nums">
                  {r.testOrderCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="px-4 py-16 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
            AUCUN SERVICE NE CORRESPOND À CES FILTRES.
          </div>
        )}
      </div>
    </>
  );
}

// ── Badges ─────────────────────────────────────────────────────────
// Keep them tiny — they sit INSIDE the Service cell to avoid adding
// another column (the table is already wide).

function PoolBadge({ row }: { row: ServiceRow }) {
  // Manual review wins over poolType='unknown' so operators see the
  // flag + know to go trancher via /config/services-review.
  if (row.classificationManualReview) {
    return <Tag label="MANUEL" color="#FFCC00" />;
  }
  if (row.poolType === "follower_test") {
    return <Tag label="ABONNÉS" color="#FF3300" />;
  }
  if (row.poolType === "engagement_test") {
    return <Tag label="ENGAGEMENT" color="#7DD3FC" />;
  }
  return <Tag label="IGNORÉ" color="#666666" />;
}

function CountryBadge({ code }: { code: string | null }) {
  if (!code) {
    return <Tag label="GLOBAL" color="#666666" />;
  }
  const flag = COUNTRY_FLAGS[code] ?? "";
  return <Tag label={`${flag} ${code}`.trim()} color="#FFFFFF" />;
}

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-block font-mono text-[10px] tracking-widest uppercase border px-2 py-0.5"
      style={{ color, borderColor: color }}
    >
      {label}
    </span>
  );
}
