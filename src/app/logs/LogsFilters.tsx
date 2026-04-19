"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

type Current = {
  range: string;
  platform: string;
  status: string;
  mode: string;
};

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
    <div className="flex flex-wrap gap-3 mb-5">
      <select
        value={current.range}
        onChange={(e) => update({ range: e.target.value })}
        className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
      >
        <option value="24h">24h</option>
        <option value="7d">7 jours</option>
        <option value="30d">30 jours</option>
        <option value="all">Tout</option>
      </select>

      <select
        value={current.platform}
        onChange={(e) => update({ platform: e.target.value })}
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
        value={current.status}
        onChange={(e) => update({ status: e.target.value })}
        className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
      >
        <option value="all">Tous statuts</option>
        <option value="success">Succès seulement</option>
        <option value="fail">Échecs seulement</option>
      </select>

      <select
        value={current.mode}
        onChange={(e) => update({ mode: e.target.value })}
        className="rounded-md border-neutral-300 border px-3 py-2 text-sm"
      >
        <option value="all">Test + Réel</option>
        <option value="dry">DRY_RUN seulement</option>
        <option value="real">Réel seulement</option>
      </select>
    </div>
  );
}
