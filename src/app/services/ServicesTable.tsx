"use client";

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
    if (serviceType !== "all") out = out.filter((r) => r.serviceType === serviceType);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) || r.category.toLowerCase().includes(q)
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
      <div className="flex flex-wrap gap-3 mb-5 items-center">
        <input
          placeholder="Rechercher nom ou catégorie..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="rounded-md border-neutral-300 border px-3 py-2 text-sm w-64"
        />
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
        >
          <option value="all">Toutes plateformes</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
        >
          <option value="all">Tous types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-md border-neutral-300 border px-3 py-2 text-sm ml-auto"
        >
          <option value="score">Tri : score</option>
          <option value="name">Tri : nom</option>
          <option value="rate">Tri : rate</option>
          <option value="orders">Tri : nb tests</option>
        </select>
      </div>

      <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-neutral-600 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left px-4 py-3">Service</th>
              <th className="text-left px-3 py-3">Platform</th>
              <th className="text-left px-3 py-3">Type</th>
              <th className="text-center px-3 py-3">Score</th>
              <th className="text-left px-3 py-3">Sparkline (30)</th>
              <th className="text-center px-3 py-3">Comp</th>
              <th className="text-center px-3 py-3">Real</th>
              <th className="text-center px-3 py-3">Speed</th>
              <th className="text-center px-3 py-3">Drop</th>
              <th className="text-right px-3 py-3">Rate/k</th>
              <th className="text-right px-3 py-3">Min</th>
              <th className="text-right px-3 py-3">Tests</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {filtered.map((r) => (
              <tr key={r.id} className="hover:bg-neutral-50">
                <td className="px-4 py-2.5 max-w-xs">
                  <div className="font-medium text-neutral-900 truncate" title={r.name}>
                    {r.name}
                  </div>
                  <div className="text-xs text-neutral-500 truncate" title={r.category}>
                    {r.category}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-neutral-700">{r.platform}</td>
                <td className="px-3 py-2.5 text-neutral-700">{r.serviceType}</td>
                <td className="px-3 py-2.5 text-center">
                  <ScoreBadge score={r.currentScore} />
                </td>
                <td className="px-3 py-2.5">
                  <Sparkline values={r.history} />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <ScoreBadge
                    score={r.completionFactor !== null ? r.completionFactor * 100 : null}
                    size="sm"
                  />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <ScoreBadge score={r.realismScore} size="sm" />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <ScoreBadge score={r.speedScore} size="sm" />
                </td>
                <td className="px-3 py-2.5 text-center">
                  <ScoreBadge score={r.dropScore} size="sm" />
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {r.ratePerK.toFixed(2)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                  {r.minQuantity}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                  {r.testOrderCount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="px-4 py-10 text-center text-sm text-neutral-500">
            Aucun service ne correspond à ces filtres.
          </div>
        )}
      </div>
    </>
  );
}
