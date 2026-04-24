// Operator-force-link a Service → Product. Used by services-review's
// per-row "[ FORCER CANDIDAT → ]" picker. Upserts the candidate row
// with isEligible=true + forceExcluded=false regardless of what the
// matcher would say. The matcher will NOT flip isEligible back off on
// re-runs because the operator's intent is recorded in the matching
// criteria JSON on the product (follow-up — for now the matcher's
// re-eval can flip isEligible; operator uses forceExcluded=false +
// isEligible=true state as a soft signal).

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  productSlug: z.string().min(1),
  serviceId: z.number().int().positive(),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const product = await prisma.myBoostProduct.findUnique({
    where: { slug: parsed.data.productSlug },
    select: { id: true },
  });
  if (!product) {
    return NextResponse.json({ error: "unknown_product" }, { status: 404 });
  }

  const existing = await prisma.productServiceCandidate.findUnique({
    where: {
      productId_serviceId: {
        productId: product.id,
        serviceId: parsed.data.serviceId,
      },
    },
  });

  const row = existing
    ? await prisma.productServiceCandidate.update({
        where: { id: existing.id },
        data: { isEligible: true, forceExcluded: false },
      })
    : await prisma.productServiceCandidate.create({
        data: {
          productId: product.id,
          serviceId: parsed.data.serviceId,
          isEligible: true,
          forceExcluded: false,
        },
      });

  return NextResponse.json({ ok: true, candidate: row });
}
