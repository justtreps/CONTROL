import { NextResponse } from "next/server";
import { runTestBot } from "@/lib/testbot";

export const maxDuration = 60;

export async function POST() {
  try {
    const result = await runTestBot();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
