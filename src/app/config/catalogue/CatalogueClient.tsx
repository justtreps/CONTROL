"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ProductRow = {
  id: number;
  slug: string;
  displayName: string;
  platform: string;
  productType: string;
  isActive: boolean;
  candidatesTotal: number;
  candidatesEligible: number;
  topThreeAvgScore: number | null;
};

type ScoringStatus = {
  scoredCount: number;
  latestScoredAt: string | null;
};

type Candidate = {
  id: number;
  rank: number | null;
  currentScore: number | null;
  isEligible: boolean;
  forceExcluded: boolean;
  targetCountry: string | null;
  lastScoredAt: string | null;
  service: {
    id: number;
    bulkmedyaId: number;
    name: string;
    platform: string;
    ratePerK: number;
    minQuantity: number;
    maxQuantity: number;
    lastTestedAt: string | null;
    active: boolean;
  };
};

type CandidateFilter = "all" | "eligible" | "excluded" | "top10";

export function CatalogueClient({
  initialRows,
  scoringStatus,
}: {
  initialRows: ProductRow[];
  scoringStatus: ScoringStatus;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [rematchBusy, setRematchBusy] = useState(false);
  const [rescoreBusy, setRescoreBusy] = useState(false);
  const [drawerSlug, setDrawerSlug] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function refreshCards() {
    const res = await fetch("/api/catalogue/products", { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as {
      products: ProductRow[];
      scoringStatus: ScoringStatus;
    };
    setRows(data.products);
  }

  async function rematch() {
    if (rematchBusy) return;
    setRematchBusy(true);
    setFlash("REMATCH EN COURS…");
    try {
      const res = await fetch("/api/catalogue/rematch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });
      if (res.ok) {
        setFlash("REMATCH TERMINÉ");
        await refreshCards();
        router.refresh();
      } else {
        setFlash(`REMATCH ÉCHEC (${res.status})`);
      }
    } finally {
      setRematchBusy(false);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  async function rescore() {
    if (rescoreBusy) return;
    setRescoreBusy(true);
    setFlash("SCORING EN COURS…");
    try {
      // Reuse the existing run-scoring endpoint. It triggers
      // runScoringEngine which now also recomputes ranks.
      const res = await fetch("/api/config/run-scoring", { method: "POST" });
      if (res.ok) {
        setFlash("SCORING TERMINÉ");
        await refreshCards();
        router.refresh();
      } else {
        setFlash(`SCORING ÉCHEC (${res.status})`);
      }
    } finally {
      setRescoreBusy(false);
      setTimeout(() => setFlash(null), 4000);
    }
  }

  return (
    <>
      {/* Product cards grid */}
      <section className="px-4 md:px-8 pb-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-0 border-y border-[#666666]/20">
          {rows.map((r, idx) => (
            <ProductCard
              key={r.slug}
              row={r}
              onOpen={() => setDrawerSlug(r.slug)}
              index={idx}
            />
          ))}
        </div>
      </section>

      {/* Scoring status + global actions */}
      <section className="px-4 md:px-8 pb-12">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-0 border border-[#666666]/30">
          <div className="p-5 md:p-6 md:border-r border-[#666666]/20">
            <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase mb-2">
              [ SCORING ENGINE ]
            </div>
            <div className="flex items-end gap-3">
              <span className="font-mono text-3xl text-white tabular-nums">
                {scoringStatus.scoredCount}
              </span>
              <span className="font-mono text-xs text-[#666666] tracking-widest uppercase pb-1">
                candidats scorés
              </span>
            </div>
            <div className="font-mono text-xs text-[#666666] tracking-wide mt-3 normal-case">
              Dernier scoring :{" "}
              <span className="text-white">
                {scoringStatus.latestScoredAt
                  ? formatAge(scoringStatus.latestScoredAt)
                  : "jamais"}
              </span>
            </div>
          </div>
          <div className="p-5 md:p-6 flex flex-col gap-3">
            <div className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
              [ ACTIONS ]
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={rematch}
                disabled={rematchBusy}
                className="interactive border border-[#FF3300] bg-[#FF3300] text-black hover:bg-[#CC2900] hover:border-[#CC2900] transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
              >
                {rematchBusy ? "[ REMATCH… ]" : "[ REMATCHER TOUS LES SERVICES ]"}
              </button>
              <button
                type="button"
                onClick={rescore}
                disabled={rescoreBusy}
                className="interactive border border-white text-white hover:bg-white hover:text-black transition-colors px-4 py-2 font-mono text-xs tracking-widest uppercase disabled:opacity-60"
              >
                {rescoreBusy ? "[ SCORING… ]" : "[ RESCORER MAINTENANT ]"}
              </button>
            </div>
            {flash && (
              <div className="font-mono text-[11px] text-[#FF3300] tracking-widest uppercase">
                {flash}
              </div>
            )}
          </div>
        </div>
      </section>

      {drawerSlug && (
        <CandidateDrawer
          slug={drawerSlug}
          onClose={() => {
            setDrawerSlug(null);
            void refreshCards();
          }}
        />
      )}
    </>
  );
}

function ProductCard({
  row,
  onOpen,
  index,
}: {
  row: ProductRow;
  onOpen: () => void;
  index: number;
}) {
  const bgVariants = ["bg-[#030303]", "bg-[#0D0D0D]"];
  const bg = bgVariants[index % 2];
  const scoreColor =
    row.topThreeAvgScore == null
      ? "text-[#666666]"
      : row.topThreeAvgScore >= 70
        ? "text-[#00CC66]"
        : row.topThreeAvgScore >= 40
          ? "text-[#FFCC00]"
          : "text-[#FF3300]";
  return (
    <div
      className={`interactive ${bg} border border-[#666666]/20 p-5 md:p-6 flex flex-col gap-3 cursor-pointer transition-colors hover:border-[#FF3300]/60`}
      onClick={onOpen}
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className="font-mono text-[10px] tracking-widest uppercase border border-[#666666]/40 text-[#666666] px-2 py-0.5"
        >
          {row.platform === "instagram" ? "IG" : "TT"} ·{" "}
          {row.productType.toUpperCase()}
        </span>
        <span
          className={`font-mono text-[10px] tracking-widest uppercase ${
            row.isActive ? "text-[#00CC66]" : "text-[#666666]"
          }`}
        >
          {row.isActive ? "ACTIF" : "INACTIF"}
        </span>
      </div>
      <h3 className="brand font-display text-xl md:text-2xl uppercase tracking-tight text-white m-0 leading-tight">
        {row.displayName}
      </h3>
      <div className="flex flex-col gap-1 mt-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl text-white tabular-nums">
            {row.candidatesEligible}
          </span>
          <span className="font-mono text-[10px] text-[#666666] tracking-widest uppercase">
            / {row.candidatesTotal} candidats éligibles
          </span>
        </div>
        <div className="font-mono text-[10px] text-[#666666] tracking-wide normal-case">
          Score moyen top 3 :{" "}
          <span className={`${scoreColor} font-mono tabular-nums`}>
            {row.topThreeAvgScore == null
              ? "—"
              : row.topThreeAvgScore.toFixed(1)}
          </span>
        </div>
      </div>
      <button
        type="button"
        className="interactive mt-auto text-left font-mono text-[11px] tracking-widest uppercase border border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black transition-colors px-3 py-1.5 w-max"
      >
        [ VOIR DÉTAILS → ]
      </button>
    </div>
  );
}

function CandidateDrawer({
  slug,
  onClose,
}: {
  slug: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    product: {
      slug: string;
      displayName: string;
      platform: string;
      productType: string;
    };
    candidates: Candidate[];
  } | null>(null);
  const [filter, setFilter] = useState<CandidateFilter>("eligible");
  const [busy, setBusy] = useState<Record<number, boolean>>({});

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/catalogue/products/${slug}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const j = await res.json();
    setData(j);
  }, [slug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleExclude(c: Candidate) {
    if (busy[c.id]) return;
    setBusy((b) => ({ ...b, [c.id]: true }));
    try {
      const res = await fetch(`/api/catalogue/candidates/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forceExcluded: !c.forceExcluded }),
      });
      if (res.ok) await refresh();
    } finally {
      setBusy((b) => ({ ...b, [c.id]: false }));
    }
  }

  const filtered: Candidate[] = data
    ? filter === "all"
      ? data.candidates
      : filter === "eligible"
        ? data.candidates.filter((c) => c.isEligible && !c.forceExcluded)
        : filter === "excluded"
          ? data.candidates.filter((c) => c.forceExcluded || !c.isEligible)
          : data.candidates
              .filter((c) => c.isEligible && !c.forceExcluded)
              .slice(0, 10)
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Fermer"
        className="flex-1 bg-black/70 backdrop-blur-sm"
      />
      <div className="relative w-full sm:w-[860px] max-w-full bg-[#030303] border-l-2 border-[#FF3300] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-[#666666]/30 bg-[#0D0D0D] sticky top-0 z-10">
          <div className="min-w-0">
            <div className="font-mono text-[10px] text-[#FF3300] tracking-widest uppercase">
              [ CATALOGUE · {slug} ]
            </div>
            <h3
              id="drawer-title"
              className="brand font-display text-2xl md:text-3xl uppercase tracking-tight text-white leading-none m-0 mt-1"
            >
              {data?.product.displayName ?? "…"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="interactive font-mono text-xs tracking-widest uppercase text-[#666666] hover:text-white px-3 py-1 border border-[#666666]/40 hover:border-white transition-colors"
          >
            [ ✕ ]
          </button>
        </div>

        {/* Filter bar */}
        <div className="px-5 py-3 border-b border-[#666666]/20 flex gap-0 flex-wrap">
          {(
            [
              ["eligible", "ÉLIGIBLES"],
              ["top10", "TOP 10"],
              ["excluded", "EXCLUS"],
              ["all", "TOUS"],
            ] as Array<[CandidateFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={
                "interactive px-3 py-1.5 font-mono text-[11px] tracking-widest uppercase border-b-2 transition-colors " +
                (filter === key
                  ? "border-[#FF3300] text-white"
                  : "border-transparent text-[#666666] hover:text-white")
              }
            >
              [ {label} ]
            </button>
          ))}
        </div>

        {/* Table */}
        {!data ? (
          <div className="px-6 py-12 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
            CHARGEMENT…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-12 text-center font-mono text-xs text-[#666666] tracking-widest uppercase">
            AUCUN CANDIDAT DANS CETTE VUE
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-[#0D0D0D] text-[#666666] font-mono text-[10px] uppercase tracking-widest">
              <tr className="border-b border-[#666666]/20">
                <th className="text-left px-3 py-2 font-normal">#</th>
                <th className="text-left px-3 py-2 font-normal">Service</th>
                <th className="text-left px-3 py-2 font-normal">Géo</th>
                <th className="text-left px-3 py-2 font-normal">Score</th>
                <th className="text-left px-3 py-2 font-normal">Dernier test</th>
                <th className="text-right px-3 py-2 font-normal">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  className={
                    "border-b border-[#666666]/10 " +
                    (c.forceExcluded || !c.isEligible
                      ? "opacity-50"
                      : "hover:bg-[#0D0D0D]")
                  }
                >
                  <td className="px-3 py-2 font-mono text-[11px] text-[#666666] tabular-nums whitespace-nowrap">
                    {c.rank != null ? `#${c.rank}` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-white max-w-xs">
                    <div className="truncate" title={c.service.name}>
                      {c.service.name}
                    </div>
                    <div className="font-mono text-[9px] text-[#FF3300]/80 mt-0.5 tracking-widest">
                      #{c.service.bulkmedyaId} · {c.service.ratePerK}/K
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-[#666666] tracking-widest uppercase">
                    {c.targetCountry ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-white tabular-nums whitespace-nowrap">
                    {c.currentScore == null
                      ? "—"
                      : c.currentScore.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-[#666666] whitespace-nowrap">
                    {formatAge(c.service.lastTestedAt)}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => toggleExclude(c)}
                      disabled={busy[c.id]}
                      className={
                        "interactive border px-3 py-1 font-mono text-[11px] tracking-widest uppercase disabled:opacity-60 " +
                        (c.forceExcluded
                          ? "border-[#00CC66] text-[#00CC66] hover:bg-[#00CC66] hover:text-black"
                          : "border-[#FF3300] text-[#FF3300] hover:bg-[#FF3300] hover:text-black")
                      }
                    >
                      {c.forceExcluded
                        ? "[ RÉINCLURE ]"
                        : "[ FORCER EXCLUSION ]"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatAge(iso: string | null): string {
  if (!iso) return "JAMAIS";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / (24 * 3600 * 1000));
  if (days < 1) return "AUJOURD'HUI";
  if (days < 30) return `IL Y A ${days}J`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `IL Y A ${months} MOIS`;
  }
  const years = (days / 365).toFixed(1);
  return `IL Y A ${years} AN${Number(years) >= 2 ? "S" : ""}`;
}
