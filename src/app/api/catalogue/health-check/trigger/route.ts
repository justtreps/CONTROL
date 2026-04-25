// Manual trigger from the dashboard "FORCER UNE SYNC" button.
// Middleware enforces session auth — operator only.

import { NextResponse } from "next/server";
import { runCatalogueHealthCheck } from "@/lib/catalogue/health-check";

export const maxDuration = 300;

export async function POST() {
  try {
    const summary = await runCatalogueHealthCheck();
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
