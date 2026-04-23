// Daily (03:15 UTC) reset of the monthly quotaUsed counter. Each
// RapidApiKey row carries its own resetDayOfMonth — we fire this
// cron every day and reset only the keys whose reset day is
// reached. Also clamps resetDayOfMonth > month-length to the last
// day of the month (so a "31" reset day lands on the 28th in
// February, etc.).
//
// Any key in status='capped' is flipped back to 'active' on its
// reset day so jobs can pick it up again.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 30;

function lastDayOfMonth(d: Date): number {
  return new Date(d.getUTCFullYear(), d.getUTCMonth() + 1, 0).getUTCDate();
}

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const dayNow = now.getUTCDate();
  const lastDay = lastDayOfMonth(now);

  const all = await prisma.rapidApiKey.findMany({
    where: { resetDayOfMonth: { not: null } },
    select: { id: true, resetDayOfMonth: true, status: true, label: true },
  });

  let reset = 0;
  const resetRows: Array<{ id: number; label: string }> = [];

  for (const k of all) {
    const configuredDay = k.resetDayOfMonth ?? 0;
    // Clamp: if the configured day exceeds the month length, use
    // last day of month so Feb with day=30 still resets on 28/29.
    const effectiveDay = Math.min(configuredDay, lastDay);
    if (dayNow !== effectiveDay) continue;
    await prisma.rapidApiKey.update({
      where: { id: k.id },
      data: {
        quotaUsed: 0,
        // Revive capped keys; leave 'disabled' alone.
        ...(k.status === "capped" ? { status: "active" } : {}),
      },
    });
    reset++;
    resetRows.push({ id: k.id, label: k.label });
  }

  console.log(
    `[rapidapi-keys-reset] day=${dayNow} reset=${reset} keys=${JSON.stringify(resetRows).slice(0, 400)}`
  );
  return NextResponse.json({ ok: true, day: dayNow, reset, keys: resetRows });
}

export const GET = POST;
