import { NextResponse } from "next/server";
import { z } from "zod";
import { setConfig } from "@/lib/config";

const bodySchema = z.object({
  bulkmedyaKey: z.string().min(1).optional(),
  rapidApiKey: z.string().min(1).optional(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { bulkmedyaKey, rapidApiKey } = parsed.data;
  if (bulkmedyaKey) await setConfig("bulkmedya_api_key", bulkmedyaKey);
  if (rapidApiKey) await setConfig("rapidapi_key", rapidApiKey);

  return NextResponse.json({ ok: true });
}
