// Raw dump of what /userfollowers/?username_or_id=<seed> returns so
// we can spot-check the upstream payload before any parsing.

import { NextResponse } from "next/server";
import { getRapidApiKey } from "@/lib/config";

export const maxDuration = 30;

const HOST = "instagram-scraper-20251.p.rapidapi.com";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const seed = url.searchParams.get("seed") ?? "cristiano";

  const key = await getRapidApiKey();
  if (!key)
    return NextResponse.json({ error: "no rapidapi key" }, { status: 500 });

  const res = await fetch(
    `https://${HOST}/userfollowers/?username_or_id=${encodeURIComponent(seed)}`,
    {
      headers: {
        "x-rapidapi-key": key,
        "x-rapidapi-host": HOST,
      },
      cache: "no-store",
    }
  );
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-json — return text */
  }

  const truncated = typeof body === "object" && body !== null
    ? truncate(body, 20)
    : text.slice(0, 2000);

  return NextResponse.json({
    url: `/userfollowers/?username_or_id=${seed}`,
    status: res.status,
    body: truncated,
  });
}

// Keep max 20 entries in each array so the response stays readable.
function truncate<T>(obj: T, max: number): T {
  if (Array.isArray(obj)) {
    return obj.slice(0, max).map((x) => truncate(x, max)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = truncate(v, max);
    }
    return out as T;
  }
  return obj;
}
