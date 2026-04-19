"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

type Current = {
  range: string;
  platform: string;
  status: string;
  mode: string;
};

const FILTER =
  "interactive bg-transparent border border-[#666666]/30 focus:border-[#FF3300] px-3 py-2 font-mono text-xs tracking-widest uppercase text-white outline-none transition-colors";

const FIELDS = [
  { key: "range", label: "PLAGE" },
  { key: "platform", label: "PLATEFORME" },
  { key: "status", label: "STATUT" },
  { key: "mode", label: "MODE" },
] as const;

export function LogsFilters({
  platforms,
  current,
}: {
  platforms: string[];
  current: Current;
}) {
  const router = useRouter();
  const params = useSearchParams();

  const update = useCallback(
    (patch: Partial<Current>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (!v || v === "all") next.delete(k);
        else next.set(k, v);
      }
      next.delete("page");
      router.push(`/logs?${next.toString()}`);
    },
    [router, params]
  );

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <FilterCell label={FIELDS[0].label}>
        <select
          value={current.range}
          onChange={(e) => update({ range: e.target.value })}
          className={FILTER}
        >
          <option value="24h">24H</option>
          <option value="7d">7 JOURS</option>
          <option value="30d">30 JOURS</option>
          <option value="all">TOUT</option>
        </select>
      </FilterCell>

      <FilterCell label={FIELDS[1].label}>
        <select
          value={current.platform}
          onChange={(e) => update({ platform: e.target.value })}
          className={FILTER}
        >
          <option value="all">TOUTES</option>
          {platforms.map((p) => (
            <option key={p} value={p}>
              {p.toUpperCase()}
            </option>
          ))}
        </select>
      </FilterCell>

      <FilterCell label={FIELDS[2].label}>
        <select
          value={current.status}
          onChange={(e) => update({ status: e.target.value })}
          className={FILTER}
        >
          <option value="all">TOUS</option>
          <option value="success">SUCCÈS</option>
          <option value="fail">ÉCHEC</option>
        </select>
      </FilterCell>

      <FilterCell label={FIELDS[3].label}>
        <select
          value={current.mode}
          onChange={(e) => update({ mode: e.target.value })}
          className={FILTER}
        >
          <option value="all">TEST + RÉEL</option>
          <option value="dry">TEST SEULEMENT</option>
          <option value="real">RÉEL SEULEMENT</option>
        </select>
      </FilterCell>
    </div>
  );
}

function FilterCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-mono text-xs text-[#666666] tracking-widest uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}
