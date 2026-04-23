// STOP request for a PoolJob. Two modes:
//
//   Hard-stop (immediate) — the job has done zero work so no worker
//     is actually inside a tranche. Safe to flip status=stopped +
//     endedAt=now in one update. Catches the common case where the
//     fire-and-forget dispatch to the worker misfired (Vercel
//     keepalive drop) and the PoolJob sat idle waiting 5 min for
//     the safety-runner cron — operator clicks STOP, expected 0-5
//     min wait disappears.
//
//   Soft-stop (cooperative) — the job has already started doing
//     work (callsUsed > 0 or counters moved). A worker is live in
//     its tranche; we set stopRequested=true and let it exit on
//     the next loop iteration. Also fires a keepalive POST to the
//     matching runner cron so a live worker that missed its
//     initial dispatch gets re-picked within seconds rather than
//     waiting 5 min for the next scheduled tick.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const RUNNER_PATH: Record<string, string> = {
  scrape: "/api/cron/pool-scrape-runner",
  health_check: "/api/cron/pool-health-check-runner",
  engagement_extract: "/api/cron/pool-engagement-extract-runner",
  engagement_fill: "/api/cron/pool-engagement-fill-runner",
};

function hasMadeProgress(
  jobType: string,
  stats: Record<string, unknown> | null
): boolean {
  if (!stats) return false;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const calls = n(stats.callsUsed);
  if (calls > 0) return true;
  switch (jobType) {
    case "scrape":
      return n(stats.addedA) + n(stats.addedB) > 0;
    case "health_check":
      return n(stats.checked) > 0;
    case "engagement_extract":
      return n(stats.addedPosts) + n(stats.accountsProcessed) > 0;
    case "engagement_fill": {
      const ext = stats.extract as Record<string, unknown> | undefined;
      const scr = stats.scrape as Record<string, unknown> | undefined;
      return (
        n(stats.totalAdded) > 0 ||
        n(ext?.callsUsed) > 0 ||
        n(scr?.callsUsed) > 0
      );
    }
    default:
      return false;
  }
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const row = await prisma.poolJob.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!["pending", "running"].includes(row.status)) {
    return NextResponse.json(
      { error: "already_terminal", status: row.status },
      { status: 409 }
    );
  }

  const progressed = hasMadeProgress(
    row.jobType,
    row.stats as Record<string, unknown> | null
  );

  if (!progressed) {
    // Hard-stop — no worker ever touched this row. Flip terminal in
    // one update; runners short-circuit on "already_terminal" when
    // they next tick.
    await prisma.poolJob.update({
      where: { id },
      data: {
        status: "stopped",
        stopRequested: true,
        endedAt: new Date(),
      },
    });
    return NextResponse.json({ ok: true, mode: "hard_stop" });
  }

  // Soft-stop — worker is live, signal cooperatively.
  await prisma.poolJob.update({
    where: { id },
    data: { stopRequested: true },
  });

  // Kick the runner cron so a dispatched worker that missed its
  // initial keepalive fetch gets re-picked fast. Idempotency is at
  // the runner level (it checks for already-live jobs).
  const runnerPath = RUNNER_PATH[row.jobType];
  if (runnerPath) {
    const origin = new URL(req.url).origin;
    void fetch(`${origin}${runnerPath}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
      keepalive: true,
    }).catch((e) => {
      console.error(
        `[stop] failed to kick ${runnerPath}: ${(e as Error).message}`
      );
    });
  }

  return NextResponse.json({ ok: true, mode: "soft_stop" });
}
