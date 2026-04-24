// Manual triage + obsolescence audit for services.
//
// Default tab (pending) = the classic queue: rows the classifier
// flagged as classificationManualReview=true (operator decides
// poolType/disable).
//
// Obsolescence tabs (never / 6mo / 1y / 2y) = rows WITH a decided
// poolType (non-unknown, active) whose lastTestedAt matches the
// window. Catches services the router stopped dispatching but the
// testbot never revalidated — likely dead on BulkMedya's side or
// superseded by a variant. Operator eyeballs + archives.

import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { ServicesReviewTable } from "./ServicesReviewTable";
import { hasSuspectWording } from "@/lib/services/classifier";

export const dynamic = "force-dynamic";

type Filter = "pending" | "never" | "6mo" | "1y" | "2y";

const FILTER_LABELS: Record<Filter, string> = {
  pending: "EN ATTENTE",
  never: "JAMAIS TESTÉ",
  "6mo": "> 6 MOIS",
  "1y": "> 1 AN",
  "2y": "> 2 ANS",
};

function ageCutoff(filter: Filter): Date | null {
  const now = Date.now();
  switch (filter) {
    case "6mo":
      return new Date(now - 6 * 30 * 24 * 3600 * 1000);
    case "1y":
      return new Date(now - 365 * 24 * 3600 * 1000);
    case "2y":
      return new Date(now - 2 * 365 * 24 * 3600 * 1000);
    default:
      return null;
  }
}

export default async function ServicesReviewPage({
  searchParams,
}: {
  searchParams?: { filter?: string };
}) {
  const raw = searchParams?.filter ?? "pending";
  const filter: Filter = (
    ["pending", "never", "6mo", "1y", "2y"] as const
  ).includes(raw as Filter)
    ? (raw as Filter)
    : "pending";

  // Compute WHERE clause per tab. Obsolescence tabs skip manual-
  // review rows entirely — those are already triagable on the
  // pending tab, no need to duplicate.
  const where =
    filter === "pending"
      ? { classificationManualReview: true, active: true }
      : filter === "never"
        ? {
            classificationManualReview: false,
            active: true,
            poolType: { not: "unknown" },
            lastTestedAt: null,
          }
        : {
            classificationManualReview: false,
            active: true,
            poolType: { not: "unknown" },
            lastTestedAt: { not: null, lt: ageCutoff(filter) ?? new Date() },
          };

  const rows = await prisma.service.findMany({
    where,
    orderBy:
      filter === "pending"
        ? [{ platform: "asc" }, { name: "asc" }]
        : [{ lastTestedAt: { sort: "asc", nulls: "first" } }, { platform: "asc" }],
    select: {
      id: true,
      bulkmedyaId: true,
      name: true,
      platform: true,
      serviceType: true,
      poolType: true,
      targetCountry: true,
      classificationManualReview: true,
      active: true,
      lastTestedAt: true,
    },
    take: 500,
  });

  // Counts per tab — single grouped query + 4 filtered counts.
  // Kept small: we only need numbers for the tab badges, not full
  // row data.
  const now = new Date();
  const [pendingCount, neverCount, sixMoCount, oneYearCount, twoYearCount] =
    await Promise.all([
      prisma.service.count({
        where: { classificationManualReview: true, active: true },
      }),
      prisma.service.count({
        where: {
          classificationManualReview: false,
          active: true,
          poolType: { not: "unknown" },
          lastTestedAt: null,
        },
      }),
      prisma.service.count({
        where: {
          classificationManualReview: false,
          active: true,
          poolType: { not: "unknown" },
          lastTestedAt: {
            not: null,
            lt: new Date(now.getTime() - 6 * 30 * 24 * 3600 * 1000),
          },
        },
      }),
      prisma.service.count({
        where: {
          classificationManualReview: false,
          active: true,
          poolType: { not: "unknown" },
          lastTestedAt: {
            not: null,
            lt: new Date(now.getTime() - 365 * 24 * 3600 * 1000),
          },
        },
      }),
      prisma.service.count({
        where: {
          classificationManualReview: false,
          active: true,
          poolType: { not: "unknown" },
          lastTestedAt: {
            not: null,
            lt: new Date(now.getTime() - 2 * 365 * 24 * 3600 * 1000),
          },
        },
      }),
    ]);

  const counts: Record<Filter, number> = {
    pending: pendingCount,
    never: neverCount,
    "6mo": sixMoCount,
    "1y": oneYearCount,
    "2y": twoYearCount,
  };

  // Decorate rows with the suspect-wording flag on the server so the
  // client doesn't have to re-implement the regex.
  const decorated = rows.map((r) => ({
    ...r,
    lastTestedAt: r.lastTestedAt?.toISOString() ?? null,
    suspectWording: hasSuspectWording(r.name),
  }));

  return (
    <>
      <DashboardHeader />
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-6 md:pb-8">
        <div className="max-w-7xl mx-auto flex flex-col gap-4">
          <Link
            href="/config"
            className="interactive font-mono text-xs text-[#666666] hover:text-white tracking-widest uppercase"
          >
            ← CONFIG
          </Link>
          <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0">
            Services à trancher.
          </h1>
          <p className="font-mono text-xs text-[#666666] normal-case leading-relaxed max-w-3xl">
            Onglet <span className="text-white">EN ATTENTE</span> = classifier
            incertain, tu décides. Les 4 autres onglets auditent les services
            déjà classés mais jamais testés ou pas revalidés depuis longtemps —
            candidats probables à la désactivation.
          </p>
        </div>
      </section>

      {/* Filter tabs */}
      <section className="px-4 md:px-8">
        <div className="max-w-7xl mx-auto flex flex-wrap gap-0 border-b border-[#666666]/30">
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
            <Link
              key={f}
              href={`/config/services-review?filter=${f}`}
              className={
                "interactive px-4 py-3 font-mono text-xs tracking-widest uppercase border-b-2 transition-colors " +
                (f === filter
                  ? "border-[#FF3300] text-white bg-[#0D0D0D]"
                  : "border-transparent text-[#666666] hover:text-white")
              }
            >
              [ {FILTER_LABELS[f]} · {counts[f]} ]
            </Link>
          ))}
        </div>
      </section>

      <ServicesReviewTable
        initial={decorated}
        filter={filter}
        totalCount={counts[filter]}
      />
    </>
  );
}
