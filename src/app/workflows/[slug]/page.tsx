// Workflow detail — React Flow canvas + run history drawer.

import Link from "next/link";
import { notFound } from "next/navigation";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import type { NodesArray } from "@/lib/workflows/nodes";
import { WorkflowDetailClient } from "./WorkflowDetailClient";
import { cadenceLabel } from "../cadence";

export const dynamic = "force-dynamic";

export default async function WorkflowDetailPage({
  params,
}: {
  params: { slug: string };
}) {
  const w = await prisma.workflow.findUnique({
    where: { slug: params.slug },
  });
  if (!w) return notFound();

  const runs = await prisma.workflowRun.findMany({
    where: { workflowId: w.id },
    orderBy: { startedAt: "desc" },
    take: 30,
  });

  const nodes: NodesArray = Array.isArray(w.nodes)
    ? (w.nodes as unknown as NodesArray)
    : [];

  return (
    <>
      <DashboardHeader />

      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-6">
        <div className="max-w-7xl mx-auto flex flex-col gap-3">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 font-mono text-xs text-[#666666] tracking-widest uppercase">
            <Link
              href="/config"
              className="interactive hover:text-white"
            >
              CONFIG
            </Link>
            <span>›</span>
            <Link
              href="/workflows"
              className="interactive hover:text-white"
            >
              WORKFLOWS
            </Link>
            <span>›</span>
            <span className="text-white truncate max-w-sm">
              {w.displayName}
            </span>
          </div>
          <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300] px-3 py-1 w-max">
            [ WORKFLOW · {w.category.toUpperCase()} ·{" "}
            {w.triggerType.toUpperCase()} ]
          </div>
          <h1 className="brand font-display text-4xl sm:text-5xl md:text-6xl uppercase tracking-tight leading-[0.9] text-white m-0">
            {w.displayName}
          </h1>
          {w.description && (
            <p className="font-mono text-xs text-[#999999] normal-case leading-relaxed max-w-3xl">
              {w.description}
            </p>
          )}
          <div className="font-mono text-[11px] text-[#666666] tracking-widest uppercase">
            Trigger :{" "}
            <span className="text-white">
              {w.triggerType === "cron"
                ? `cron ${w.cronExpression} · ${cadenceLabel(w.cronExpression)}`
                : w.triggerType === "event"
                  ? `event ${w.eventType}`
                  : "manual"}
            </span>
            {" · "}
            Statut :{" "}
            <span
              className={
                w.isActive ? "text-[#00CC66]" : "text-[#666666]"
              }
            >
              {w.isActive ? "ACTIF" : "INACTIF"}
            </span>
          </div>
        </div>
      </section>

      <WorkflowDetailClient
        slug={w.slug}
        category={w.category}
        displayName={w.displayName}
        isActive={w.isActive}
        nodes={nodes}
        initialRuns={runs.map((r) => ({
          id: r.id,
          status: r.status,
          trigger: r.trigger,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt?.toISOString() ?? null,
          currentNodeId: r.currentNodeId,
          logs: Array.isArray(r.logs)
            ? (r.logs as Array<{
                at: string;
                nodeId: string | null;
                level: string;
                message: string;
                durationMs?: number;
              }>)
            : [],
        }))}
      />
    </>
  );
}

