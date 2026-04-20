// Temporary diagnostic. Dumps the raw RapidAPI /userinfo/ response
// side-by-side with a public instagram.com/{username}/ HEAD check,
// so we can see which "valid" RapidAPI rows are actually ghost
// accounts that don't exist on the live web.
//
// Will be removed once the ghost-account bug is fixed.

import { NextResponse } from "next/server";
import { getRapidApiKey } from "@/lib/config";

export const maxDuration = 30;

const HOST = "instagram-scraper-20251.p.rapidapi.com";

async function rapidCall(path: string, key: string) {
  const res = await fetch(`https://${HOST}${path}`, {
    headers: {
      "x-rapidapi-key": key,
      "x-rapidapi-host": HOST,
    },
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return { status: res.status, body: json ?? text };
}

async function webCheck(username: string) {
  // Cheap HEAD against instagram.com — if the username 404s the page
  // redirects to /accounts/login/ or returns 404. We follow redirects
  // to see the final URL.
  try {
    const res = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      redirect: "follow",
      cache: "no-store",
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    });
    const html = await res.text();
    return {
      status: res.status,
      finalUrl: res.url,
      redirected: res.redirected,
      pageHasProfile: html.includes(`"username":"${username}"`),
      pageHasNotFound:
        html.includes("Sorry, this page isn't available.") ||
        html.includes("Page not found"),
      bytes: html.length,
    };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

export async function POST(req: Request) {
  const { usernames } = (await req.json().catch(() => ({}))) as {
    usernames?: string[];
  };
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return NextResponse.json(
      { error: "body must be { usernames: string[] }" },
      { status: 400 }
    );
  }
  const key = await getRapidApiKey();
  if (!key)
    return NextResponse.json(
      { error: "rapidapi key not configured" },
      { status: 500 }
    );

  const out: Array<Record<string, unknown>> = [];
  for (const username of usernames.slice(0, 10)) {
    const [userinfoRes, webRes] = await Promise.all([
      rapidCall(
        `/userinfo/?username_or_id=${encodeURIComponent(username)}`,
        key
      ),
      webCheck(username),
    ]);
    out.push({ username, rapidapi: userinfoRes, web: webRes });
  }
  return NextResponse.json({ results: out });
}
