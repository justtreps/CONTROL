// Small payload for live alert counters. Two consumers:
//   • GlobalAlertBanner (top-bar) — polls every 30 s
//   • /alertes AlertsList chips    — polls every 10 s
// Returns BOTH shape conventions so neither has to remap.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const [critical, warning, info, acknowledged, resolved] = await Promise.all([
    prisma.alert.count({
      where: { status: "active", severity: "critical" },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "warning" },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "info" },
    }),
    prisma.alert.count({ where: { status: "acknowledged" } }),
    prisma.alert.count({
      where: { status: { in: ["resolved", "auto_resolved"] } },
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
