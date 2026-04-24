// Fast path for the dashboard card — returns the currently-active
// campaign (or null) with computed ETA and accumulated cost.

import { NextResponse } from "next/server";
import { getActiveCampaign } from "@/lib/scoring/campaign";

export const dynamic = "force-dynamic";

export async function GET() {
  const active = await getActiveCampaign();
  return NextResponse.json({ active });
}
