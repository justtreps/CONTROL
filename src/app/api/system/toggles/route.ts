import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getSystemToggles,
  updateSystemToggles,
} from "@/lib/system/toggles";
import { invalidateDryRunCache } from "@/lib/router";

export async function GET() {
  const t = await getSystemToggles();
  return NextResponse.json({ toggles: t });
}

const patchSchema = z
  .object({
    poolScrapeEnabled: z.boolean().optional(),
    poolHealthcheckEnabled: z.boolean().optional(),
    routingApiEnabled: z.boolean().optional(),
    testBotEnabled: z.boolean().optional(),
    scoringEngineEnabled: z.boolean().optional(),
    workflowExecutorEnabled: z.boolean().optional(),
    dryRunMode: z.boolean().optional(),
  })
  .strict();

export async function PATCH(req: Request) {
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  try {
    const t = await updateSystemToggles(parsed.data);
    // Kick the dry-run cache so the flip is observed by callers
    // within one read instead of up to 30 s later.
    if ("dryRunMode" in parsed.data) invalidateDryRunCache();
    return NextResponse.json({ ok: true, toggles: t });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
