import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { syncServices } from "@/lib/bulkmedya";

// Scope-opening (engagement types) means BulkMedya returns ~4-5k
// candidate rows instead of ~1900; we need headroom beyond the
// default 60s Vercel Hobby cap.
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncServices();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export const GET = POST;
