import { NextResponse } from "next/server";
import { reparseServiceTypes } from "@/lib/bulkmedya";

export const maxDuration = 60;

export async function POST() {
  try {
    const result = await reparseServiceTypes();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
