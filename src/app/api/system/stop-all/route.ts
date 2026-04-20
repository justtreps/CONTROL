import { NextResponse } from "next/server";
import { stopAll } from "@/lib/system/toggles";

export async function POST() {
  try {
    const t = await stopAll();
    return NextResponse.json({ ok: true, toggles: t });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
