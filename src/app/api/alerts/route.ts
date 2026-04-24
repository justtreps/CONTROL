// List alerts with filters: status, category, severity, q.
// Session-authed via middleware.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "active_or_ack";
  const category = url.searchParams.get("category") ?? "all";
  const severity = url.searchParams.get("severity") ?? "all";
  const limit = Math.min(
    200,
    Number(url.searchParams.get("limit") ?? 100) || 100
  );

  const where: import("@prisma/client").Prisma.AlertWhereInput = {};
  if (status === "active") where.status = "active";
  else if (status === "acknowledged") where.status = "acknowledged";
  else if (status === "resolved")
    where.status = { in: ["resolved", "auto_resolved"] };
  else if (status === "active_or_ack")
    where.status = { in: ["active", "acknowledged"] };
  // 'all' → no filter
  if (category !== "all") where.category = category;
  if (severity !== "all") where.severity = severity;

  const rows = await prisma.alert.findMany({
    where,
    orderBy: [
      // critical > warning > info — custom order via case expr would
      // be nicer; simple two-key sort covers 95 % of the time since
      // severity has only 3 values.
      { severity: "desc" },
      { lastTriggeredAt: "desc" },
    ],
    take: limit,
  });

  // Normalise severity sort so 'critical' ranks above 'warning' above
  // 'info' (string DESC does critical>warning>info by accident of
  // alphabet actually — c>w>i is wrong direction. Override here).
  const severityRank: Record<string, number> = {
    critical: 3,
    warning: 2,
    info: 1,
  };
  rows.sort((a, b) => {
    const sa = severityRank[a.severity] ?? 0;
    const sb = severityRank[b.severity] ?? 0;
    if (sa !== sb) return sb - sa;
    return b.lastTriggeredAt.getTime() - a.lastTriggeredAt.getTime();
  });

  return NextResponse.json({
    alerts: rows.map((a) => ({
      ...a,
      firstTriggeredAt: a.firstTriggeredAt.toISOString(),
      lastTriggeredAt: a.lastTriggeredAt.toISOString(),
      resolvedAt: a.resolvedAt?.toISOString() ?? null,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    })),
  });
}
