// Small payload for live alert counters. Two consumers:
//   • GlobalAlertBanner (top-bar) — polls every 30 s, no filter
//   • /alertes AlertsList chips    — polls every 10 s, optionally
//     scoped by category so the chip counts match the rows the
//     operator is actually viewing (otherwise clicking CRITIQUE
//     would jump to ALL criticals, hiding the category filter).
// Returns BOTH shape conventions so neither has to remap.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const category = url.searchParams.get("category") ?? "all";
  const categoryFilter = category !== "all" ? { category } : {};

  const [critical, warning, info, acknowledged, resolved] = await Promise.all([
    prisma.alert.count({
      where: { status: "active", severity: "critical", ...categoryFilter },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "warning", ...categoryFilter },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "info", ...categoryFilter },
    }),
    prisma.alert.count({
      where: { status: "acknowledged", ...categoryFilter },
    }),
    prisma.alert.count({
      where: {
        status: { in: ["resolved", "auto_resolved"] },
        ...categoryFilter,
      },
    }),
  ]);
  return NextResponse.json({
    // Banner shape (legacy)
    critical,
    warning,
    info,
    total: critical + warning + info,
    acknowledged,
    // AlertsList shape (5 chips)
    crit: critical,
    warn: warning,
    ack: acknowledged,
    resolved,
  });
}
