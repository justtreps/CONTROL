import { NextResponse } from "next/server";
import { seedPoolDefaults } from "@/lib/pool/seed";

export const maxDuration = 30;

export async function POST() {
  try {
    const result = await seedPoolDefaults();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
