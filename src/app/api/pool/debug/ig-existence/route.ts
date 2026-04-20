// Multi-source existence checker for an IG (username, userId) pair.
// IG's topsearch rejects our server origin. This probe tries several
// alternative verification surfaces so we can triangulate whether
// RapidAPI /userinfo/ is hallucinating.
//
// Endpoints tried:
//   - https://i.instagram.com/api/v1/users/{user_id}/info/    (mobile app API)
//   - https://www.instagram.com/api/v1/users/web_profile_info/?username={u}
//   - https://api.instagram.com/oembed/?url=https://instagram.com/{u}
//   - rapidapi instagram-scraper-20251 /userinfo/ (our current)
//   - rapidapi instagram-looter2 /profile (same key — works only if
//     the account is subscribed; expect 401/403 otherwise)
//
// Returns each source's status + a few diagnostic fields. No DB side
// effects.

import { NextResponse } from "next/server";
import { getRapidApiKey } from "@/lib/config";

export const maxDuration = 30;

const IG_UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x2137; samsung; SM-G950F; dreamlte; samsungexynos8895; en_US; 450281742)";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

type Probe = { source: string; status: number; ok: boolean; summary: string; raw?: unknown };

async function igMobileUserInfo(userId: string): Promise<Probe> {
  try {
    const res = await fetch(
      `https://i.instagram.com/api/v1/users/${encodeURIComponent(userId)}/info/`,
      {
        headers: {
          "user-agent": IG_UA,
          "x-ig-app-id": "936619743392459",
          accept: "*/*",
        },
        cache: "no-store",
      }
    );
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* */ }
    const user = typeof body === "object" && body !== null ? (body as Record<string, unknown>).user : null;
    const hasUser = Boolean(user && typeof user === "object");
    const snippet = hasUser
      ? `user.username=${(user as Record<string, unknown>).username} pk=${(user as Record<string, unknown>).pk} followers=${(user as Record<string, unknown>).follower_count}`
      : text.slice(0, 200);
    return {
      source: "i.instagram.com/api/v1/users/{id}/info",
      status: res.status,
      ok: res.ok && hasUser,
      summary: snippet,
    };
  } catch (e) {
    return {
      source: "i.instagram.com/api/v1/users/{id}/info",
      status: 0,
      ok: false,
      summary: (e as Error).message,
    };
  }
}

async function igWebProfileInfo(username: string): Promise<Probe> {
  try {
    const res = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      {
        headers: {
          "user-agent": BROWSER_UA,
          "x-ig-app-id": "936619743392459",
          accept: "*/*",
        },
        cache: "no-store",
      }
    );
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* */ }
    const user = typeof body === "object" && body !== null
      ? ((body as Record<string, unknown>).data as Record<string, unknown> | undefined)?.user
      : null;
    const hasUser = Boolean(user && typeof user === "object");
    const snippet = hasUser
      ? `username=${(user as Record<string, unknown>).username} id=${(user as Record<string, unknown>).id} followers=${((user as Record<string, unknown>).edge_followed_by as Record<string, unknown> | undefined)?.count}`
      : text.slice(0, 200);
    return {
      source: "www.instagram.com/api/v1/users/web_profile_info",
      status: res.status,
      ok: res.ok && hasUser,
      summary: snippet,
    };
  } catch (e) {
    return {
      source: "www.instagram.com/api/v1/users/web_profile_info",
      status: 0,
      ok: false,
      summary: (e as Error).message,
    };
  }
}

async function igOembed(username: string): Promise<Probe> {
  try {
    const res = await fetch(
      `https://api.instagram.com/oembed/?url=https://instagram.com/${encodeURIComponent(username)}/`,
      { cache: "no-store" }
    );
    const text = await res.text();
    return {
      source: "api.instagram.com/oembed",
      status: res.status,
      ok: res.ok,
      summary: text.slice(0, 200),
    };
  } catch (e) {
    return {
      source: "api.instagram.com/oembed",
      status: 0,
      ok: false,
      summary: (e as Error).message,
    };
  }
}

async function rapidUserinfoById(userId: string, key: string): Promise<Probe> {
  try {
    const res = await fetch(
      `https://instagram-scraper-20251.p.rapidapi.com/userinfo/?username_or_id=${encodeURIComponent(userId)}`,
      {
        headers: {
          "x-rapidapi-key": key,
          "x-rapidapi-host": "instagram-scraper-20251.p.rapidapi.com",
        },
        cache: "no-store",
      }
    );
    const text = await res.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* */ }
    const b = (body ?? {}) as Record<string, unknown>;
    const data = b.data as Record<string, unknown> | undefined;
    const detail = b.detail as string | undefined;
    const ok = Boolean(data && data.id);
    const snippet = ok
      ? `id=${data!.id} username=${data!.username} followers=${data!.follower_count} media=${data!.media_count}`
      : detail ?? text.slice(0, 200);
    return {
      source: "rapidapi/instagram-scraper-20251/userinfo",
      status: res.status,
      ok,
      summary: snippet,
    };
  } catch (e) {
    return {
      source: "rapidapi/instagram-scraper-20251/userinfo",
      status: 0,
      ok: false,
      summary: (e as Error).message,
    };
  }
}

async function rapidLooter2(username: string, key: string): Promise<Probe> {
  // Same key — only works if this provider is also subscribed on the
  // key's account. Returns 401/403 otherwise, which is still useful:
  // it tells us whether the host is reachable and what shape it'd return.
  try {
    const res = await fetch(
      `https://instagram-looter2.p.rapidapi.com/profile?username=${encodeURIComponent(username)}`,
      {
        headers: {
          "x-rapidapi-key": key,
          "x-rapidapi-host": "instagram-looter2.p.rapidapi.com",
        },
        cache: "no-store",
      }
    );
    const text = await res.text();
    return {
      source: "rapidapi/instagram-looter2/profile",
      status: res.status,
      ok: res.ok,
      summary: text.slice(0, 250),
    };
  } catch (e) {
    return {
      source: "rapidapi/instagram-looter2/profile",
      status: 0,
      ok: false,
      summary: (e as Error).message,
    };
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const username = url.searchParams.get("username") ?? "";
  const userId = url.searchParams.get("userId") ?? "";
  if (!username && !userId) {
    return NextResponse.json(
      { error: "pass ?username=X or ?userId=N (or both)" },
      { status: 400 }
    );
  }

  const key = await getRapidApiKey();
  if (!key)
    return NextResponse.json({ error: "no rapidapi key" }, { status: 500 });

  const probes: Probe[] = [];

  if (userId) {
    probes.push(await igMobileUserInfo(userId));
    probes.push(await rapidUserinfoById(userId, key));
  }
  if (username) {
    probes.push(await igWebProfileInfo(username));
    probes.push(await igOembed(username));
    probes.push(await rapidLooter2(username, key));
  }

  // Consolidated verdict: majority vote of OK sources.
  const okCount = probes.filter((p) => p.ok).length;
  const notOkCount = probes.filter((p) => !p.ok).length;
  let verdict = "inconclusive";
  if (okCount >= 2) verdict = "EXISTS_confirmed_by_multiple";
  else if (okCount === 1) verdict = "EXISTS_one_source_only";
  else if (notOkCount > 0) verdict = "LIKELY_GHOST_no_source_confirms";

  return NextResponse.json({
    username,
    userId,
    verdict,
    okCount,
    notOkCount,
    probes,
  });
}
