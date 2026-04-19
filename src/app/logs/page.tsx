import Link from "next/link";
import { DashboardHeader } from "@/components/DashboardHeader";
import { ScoreBadge } from "@/components/ScoreBadge";
import { prisma } from "@/lib/prisma";
import { LogsFilters } from "./LogsFilters";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const RANGES: Record<string, number | null> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  all: null,
};

function parseRange(v: string | undefined): number | null {
  if (!v || !(v in RANGES)) return RANGES["7d"];
  return RANGES[v];
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: { [k: string]: string | undefined };
}) {
  const range = parseRange(searchParams.range);
  const platform = searchParams.platform ?? "all";
  const status = searchParams.status ?? "all";
  const mode = searchParams.mode ?? "all";
  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);

  const where: Prisma.RoutingDecisionWhereInput = {};
  if (range !== null) {
    where.decidedAt = { gte: new Date(Date.now() - range * 3600 * 1000) };
  }
  if (platform !== "all") where.platform = platform;
  if (status === "success") where.success = true;
  if (status === "fail") where.success = false;
  if (mode === "dry") where.dryRun = true;
  if (mode === "real") where.dryRun = false;

  const [rows, total, platforms] = await Promise.all([
    prisma.routingDecision.findMany({
      where,
      orderBy: { decidedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.routingDecision.count({ where }),
    prisma.routingDecision.findMany({
      distinct: ["platform"],
      select: { platform: true },
    }),
  ]);

  const serviceIds = Array.from(
    new Set(rows.map((r) => r.chosenServiceId).filter((v): v is number => v != null))
  );
  const services = await prisma.service.findMany({
    where: { id: { in: serviceIds } },
    select: { id: true, name: true, platform: true },
  });
  const serviceById = new Map(services.map((s) => [s.id, s]));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <DashboardHeader />
      <main className="max-w-7xl mx-auto px-6 py-10">
        <div className="flex items-baseline justify-between mb-6">
          <h1 className="brand text-3xl">Logs</h1>
          <p className="text-sm text-neutral-500 tabular-nums">
            {total} décisions
          </p>
        </div>

        <LogsFilters
          platforms={platforms.map((p) => p.platform).sort()}
          current={{
            range: searchParams.range ?? "7d",
            platform,
            status,
            mode,
          }}
        />

        <div className="bg-white border border-neutral-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-neutral-600 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-3">Date</th>
                <th className="text-left px-3 py-3">Plat.</th>
                <th className="text-left px-3 py-3">Type</th>
                <th className="text-right px-3 py-3">Qty</th>
                <th className="text-left px-3 py-3">Service choisi</th>
                <th className="text-center px-3 py-3">Score</th>
                <th className="text-center px-3 py-3">Status</th>
                <th className="text-center px-3 py-3">Mode</th>
                <th className="text-right px-3 py-3">Att.</th>
                <th className="text-left px-3 py-3">BM Order / Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.map((r) => {
                const service = r.chosenServiceId
                  ? serviceById.get(r.chosenServiceId)
                  : null;
                return (
                  <tr key={r.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-2.5 whitespace-nowrap text-neutral-600 font-mono text-xs">
                      {r.decidedAt.toISOString().replace("T", " ").slice(0, 19)}
                    </td>
                    <td className="px-3 py-2.5">{r.platform}</td>
                    <td className="px-3 py-2.5 text-neutral-600">{r.serviceType}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.quantity}
                    </td>
                    <td className="px-3 py-2.5">
                      {service ? (
                        <Link
                          href={`/services/${service.id}`}
                          className="text-neutral-900 hover:underline truncate block max-w-xs"
                          title={service.name}
                        >
                          {service.name}
                        </Link>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <ScoreBadge score={r.chosenServiceScore} size="sm" />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {r.success ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-800">
                          success
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">
                          fail
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {r.dryRun ? (
                        <span className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">
                          dry
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded bg-neutral-100 text-neutral-700">
                          real
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-neutral-600">
                      {r.attempts}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-neutral-500 max-w-sm truncate">
                      {r.success
                        ? r.bulkmedyaOrderId
                        : r.errorMessage ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-neutral-500">
              Aucune décision de routing pour ces filtres.
            </div>
          )}
        </div>

        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            searchParams={searchParams}
          />
        )}
      </main>
    </>
  );
}

function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: Record<string, string | undefined>;
}) {
  const link = (p: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v !== undefined) params.set(k, v);
    }
    params.set("page", String(p));
    return `/logs?${params.toString()}`;
  };

  return (
    <div className="flex items-center justify-between mt-4 text-sm">
      <div className="text-neutral-500">
        Page {page} / {totalPages}
      </div>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={link(page - 1)}
            className="px-3 py-1.5 border border-neutral-300 rounded hover:bg-neutral-50"
          >
            ← Précédent
          </Link>
        )}
        {page < totalPages && (
          <Link
            href={link(page + 1)}
            className="px-3 py-1.5 border border-neutral-300 rounded hover:bg-neutral-50"
          >
            Suivant →
          </Link>
        )}
      </div>
    </div>
  );
}
