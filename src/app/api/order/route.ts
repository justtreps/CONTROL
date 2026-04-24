// MyBoost → CONTROL order endpoint. Supports the new product-catalog
// routing (send `product: "ig-followers"`) and the legacy
// (`platform` + `service_type`) shape for backward compatibility.
// Both resolve to a ProductServiceCandidate behind the scenes; the
// router picks the best-ranked, scored service and falls back through
// the ranks on provider error.
import { NextResponse } from "next/server";
import { z } from "zod";
import { routeOrder } from "@/lib/router";
import { getSystemToggles } from "@/lib/system/toggles";

export const maxDuration = 30;

// Either `product` OR (`platform` + `service_type`) must be present.
const bodySchema = z
  .object({
    product: z.string().min(1).optional(),
    platform: z.string().min(1).optional(),
    service_type: z.string().min(1).optional(),
    quantity: z.number().int().positive(),
    target_url: z.string().url(),
  })
  .refine((d) => Boolean(d.product) || (d.platform && d.service_type), {
    message: "either `product` OR (`platform`+`service_type`) is required",
    path: ["product"],
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

  const toggles = await getSystemToggles();
  if (!toggles.routingApiEnabled) {
    return NextResponse.json(
      {
        error: "system_paused",
        message:
          "CONTROL routing is paused by the kill switch. Fall back to your existing routing system.",
      },
      { status: 503 }
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const { product, platform, service_type, quantity, target_url } =
    parsed.data;

  const result = await routeOrder({
    product,
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
