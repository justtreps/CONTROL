import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getSystemToggles,
  updateSystemToggles,
} from "@/lib/system/toggles";

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
    adaptivePollingEnabled: z.boolean().optional(),
    workflowExecutorEnabled: z.boolean().optional(),
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
    return NextResponse.json({ ok: true, toggles: t });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
