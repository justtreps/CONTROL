// Manual triage page for services the classifier flagged as
// `classificationManualReview=true`. The operator can click one of
// three buttons per row to force a poolType, or edit the target
// country. Each action PATCHes /api/config/services/[id] and
// removes the manualReview flag.

import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { ServicesReviewTable } from "./ServicesReviewTable";

export const dynamic = "force-dynamic";

export default async function ServicesReviewPage() {
  const rows = await prisma.service.findMany({
    where: { classificationManualReview: true, active: true },
    orderBy: [{ platform: "asc" }, { name: "asc" }],
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
    },
    take: 500,
  });

  return (
    <>
      <DashboardHeader />
      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-10 md:pb-12">
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
          <p className="font-mono text-xs text-[#666666] normal-case leading-relaxed max-w-2xl">
            Le classifier automatique n&apos;a pas pu décider la classification
            de ces services — soit le nom matche un bucket exclu (comment /
            story / IGTV / live), soit aucun mot-clé ne s&apos;applique. Dis
            au système quoi en faire.
          </p>
          <div className="font-mono text-xs text-[#666666] tracking-widest uppercase">
            [ {rows.length} services en attente ]
          </div>
        </div>
      </section>

      <ServicesReviewTable initial={rows} />
    </>
  );
}
