"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ScoreBadge } from "@/components/ScoreBadge";
import { Sparkline } from "@/components/Sparkline";

export type ServiceRow = {
  id: number;
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
};

type SortKey = "score" | "name" | "rate" | "orders";

const FILTER_INPUT =
  "interactive bg-transparent border border-[#666666]/30 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white placeholder:text-[#666666]/60 outline-none transition-colors";

export function ServicesTable({ rows }: { rows: ServiceRow[] }) {
  const platforms = useMemo(
    () => Array.from(new Set(rows.map((r) => r.platform))).sort(),
    [rows]
  );
  const types = useMemo(
    () => Array.from(new Set(rows.map((r) => r.serviceType))).sort(),
    [rows]
  );

  const [platform, setPlatform] = useState<string>("all");
  const [serviceType, setServiceType] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("score");

  const filtered = useMemo(() => {
    let out = rows;
    if (platform !== "all") out = out.filter((r) => r.platform === platform);
    if (serviceType !== "all")
      out = out.filter((r) => r.serviceType === serviceType);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q)
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
  }, [rows, platform, serviceType, query, sort]);

  return (
    <>
      {/* Filters bar — Pattern B compact style */}
      <div className="flex flex-wrap gap-3 px-4 md:px-6 py-4 border-b border-[#666666]/20 bg-[#0D0D0D]">
        <input
          placeholder="RECHERCHER..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={`${FILTER_INPUT} w-64`}
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className={FILTER_INPUT}
        >
          <option value="all">TOUTES PLATEFORMES</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p.toUpperCase()}
            </option>
          ))}
        </select>
        <select
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          className={FILTER_INPUT}
        >
          <option value="all">TOUS TYPES</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t.toUpperCase()}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className={`${FILTER_INPUT} ml-auto`}
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
                    title={r.name}
                  >
                    {r.name}
                  </Link>
                  <div
                    className="font-mono text-xs text-[#666666] tracking-widest uppercase truncate mt-1"
                    title={r.category}
                  >
                    {r.category}
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
