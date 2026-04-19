import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = {
    DATABASE_URL_set: !!process.env.DATABASE_URL,
    DIRECT_URL_set: !!process.env.DIRECT_URL,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  try {
    const start = Date.now();
    const count = await prisma.service.count();
    return NextResponse.json({
      ok: true,
      db: { connected: true, serviceCount: count, tookMs: Date.now() - start },
      env,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        env,
        error: {
          name: (err as Error)?.name,
          message: (err as Error)?.message,
          code: (err as { code?: string })?.code,
          stack: (err as Error)?.stack?.split("\n").slice(0, 6).join("\n"),
        },
      },
      { status: 500 }
    );
  }
}
