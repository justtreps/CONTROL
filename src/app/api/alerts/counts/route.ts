// Small payload for the GlobalAlertBanner — polled every 30s by
// the top-bar component. Returns only active + acknowledged
// counters, keyed by severity.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const [critical, warning, info] = await Promise.all([
    prisma.alert.count({
      where: { status: "active", severity: "critical" },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "warning" },
    }),
    prisma.alert.count({
      where: { status: "active", severity: "info" },
    }),
  ]);
  const acknowledged = await prisma.alert.count({
    where: { status: "acknowledged" },
  });
  return NextResponse.json({
    critical,
    warning,
    info,
    total: critical + warning + info,
    acknowledged,
  });
}
