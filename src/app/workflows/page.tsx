// Workflows list — 8 cards ordered by category. Each card surfaces
// the trigger (cron / event / manual), last run status, node count,
// and a toggle. Click the card or [ ÉDITER ] → drill into
// /workflows/[slug].

import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { prisma } from "@/lib/prisma";
import { WorkflowsList } from "./WorkflowsList";
import { CreateWorkflowButton } from "./CreateWorkflowButton";
import { getSystemToggles } from "@/lib/system/toggles";

export const dynamic = "force-dynamic";

export default async function WorkflowsPage() {
  const [workflows, toggles] = await Promise.all([
    prisma.workflow.findMany({
      orderBy: [{ category: "asc" }, { slug: "asc" }],
    }),
    getSystemToggles(),
  ]);

  const rows = await Promise.all(
    workflows.map(async (w) => {
      const lastRun = await prisma.workflowRun.findFirst({
        where: { workflowId: w.id },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          status: true,
          trigger: true,
        },
      });
      return {
        id: w.id,
        slug: w.slug,
        displayName: w.displayName,
        description: w.description ?? "",
        category: w.category,
        triggerType: w.triggerType,
        cronExpression: w.cronExpression,
        eventType: w.eventType,
        isActive: w.isActive,
        nodeCount: Array.isArray(w.nodes) ? w.nodes.length : 0,
        lastRun: lastRun
          ? {
              status: lastRun.status,
              trigger: lastRun.trigger,
              startedAt: lastRun.startedAt.toISOString(),
            }
          : null,
      };
    })
  );

  return (
    <>
      <DashboardHeader />

      <section className="px-4 md:px-8 pt-24 md:pt-32 pb-10">
        <div className="max-w-7xl mx-auto flex flex-col gap-4">
          <Link
            href="/config"
            className="interactive font-mono text-xs text-[#666666] hover:text-white tracking-widest uppercase"
          >
            ← CONFIG
          </Link>
          <div className="font-mono text-xs text-[#FF3300] tracking-widest border border-[#FF3300] px-3 py-1 w-max">
            [ WORKFLOWS · {rows.length} FLOWS ]
          </div>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <h1 className="brand font-display text-4xl sm:text-5xl md:text-7xl uppercase tracking-tight leading-[0.9] text-white m-0">
              Workflows.
            </h1>
            <CreateWorkflowButton />
          </div>
          <p className="font-mono text-xs text-[#666666] normal-case leading-relaxed max-w-3xl">
            Orchestrateur visuel. Chaque workflow enchaîne des nodes (fetch,
            filter, action, notify) selon un trigger cron ou event.
            L&apos;executor master tourne{" "}
            <span
              className={
                toggles.workflowExecutorEnabled
                  ? "text-[#00CC66]"
                  : "text-[#FFCC00]"
              }
            >
              {toggles.workflowExecutorEnabled
                ? "ACTIF"
                : "INACTIF (kill-switch off)"}
            </span>
            . Les crons legacy tournent en parallèle jusqu&apos;à la bascule —
            aucune duplication tant que le switch reste sur INACTIF.
          </p>
        </div>
      </section>

      <WorkflowsList
        initial={rows}
        executorEnabled={toggles.workflowExecutorEnabled}
      />
    </>
  );
}
