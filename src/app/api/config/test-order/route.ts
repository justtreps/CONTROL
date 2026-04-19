import { NextResponse } from "next/server";
import { z } from "zod";
import { routeOrder } from "@/lib/router";

export const maxDuration = 30;

const bodySchema = z.object({
  platform: z.string().min(1),
  service_type: z.string().min(1),
  quantity: z.number().int().positive(),
  target_url: z.string().url(),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { platform, service_type, quantity, target_url } = parsed.data;

  const result = await routeOrder({
    platform,
    serviceType: service_type,
    quantity,
    targetUrl: target_url,
  });

  return NextResponse.json(result, { status: result.success ? 200 : 200 });
}
