// MVP scope: CONTROL only ingests / scores / routes services that match
// (platform=instagram|tiktok, service_type=followers). See src/lib/scope.ts.
// For likes / views / comments / shares / saves / any other platform,
// MyBoost must keep routing via its existing system — NOT through this
// endpoint. A request outside the MVP scope will 404 with
// "no_eligible_service" because the scoring pool is empty for those keys.
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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function verifyApiKey(req: Request): boolean {
  const key = process.env.ORDER_API_KEY;
  if (!key) return false;
  const header = req.headers.get("authorization");
  if (!header) return false;
  return constantTimeEqual(header, `Bearer ${key}`);
}

export async function POST(req: Request) {
  if (!verifyApiKey(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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

  if (result.success) {
    return NextResponse.json(result);
  }
  const status = result.error === "no_eligible_service" ? 404 : 502;
  return NextResponse.json(result, { status });
}
