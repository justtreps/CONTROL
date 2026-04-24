// One-shot (idempotent) — upserts the 8 MyBoostProduct rows from
// src/lib/catalogue/products.ts. Safe to re-run; existing rows get
// displayName/platform/productType refreshed but slug is the key
// so matching history stays intact.

import { NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/cron-auth";
import { prisma } from "@/lib/prisma";
import { PRODUCT_SEEDS } from "@/lib/catalogue/products";

export const maxDuration = 30;

export async function POST(req: Request) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const upserted: string[] = [];
  for (const p of PRODUCT_SEEDS) {
    await prisma.myBoostProduct.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        displayName: p.displayName,
        platform: p.platform,
        productType: p.productType,
      },
      update: {
        displayName: p.displayName,
        platform: p.platform,
        productType: p.productType,
      },
    });
    upserted.push(p.slug);
  }

  return NextResponse.json({ ok: true, upserted, count: upserted.length });
}

export const GET = POST;
