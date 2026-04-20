// Cross-checks RapidAPI /userinfo/ claims against Instagram's own
// topsearch endpoint. For each (username, user_id) we also call
// IG's public topsearch by username AND by user_id and see whether
// either matches what RapidAPI said. Ghost accounts stored in the
// pool should show as absent from IG's own search index.
//
// Temporary diag endpoint — delete after the ghost-account root
// cause is nailed down.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRapidApiKey } from "@/lib/config";

export const maxDuration = 60;

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
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, body: json ?? text };
}

type IgUser = { pk: string; username: string; full_name?: string; is_private?: boolean };

async function igTopsearch(query: string) {
  // Public IG search — no auth. Returns users + hashtags + places.
  try {
    const res = await fetch(
      `https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(query)}&context=blended`,
      {
        cache: "no-store",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
      }
    );
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) {
      const body = await res.text();
      return {
        status: res.status,
        error: "non-json response",
        preview: body.slice(0, 200),
      };
    }
    const json = (await res.json()) as {
      users?: Array<{ user?: IgUser }>;
    };
    const hits = (json.users ?? [])
      .map((u) => u.user)
      .filter((u): u is IgUser => !!u)
      .map((u) => ({ pk: u.pk, username: u.username, full_name: u.full_name ?? "" }));
    return { status: res.status, hits };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

function extractRapidUser(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.detail === "string") return { error: b.detail as string };
  const data = b.data as Record<string, unknown> | undefined;
  if (!data) return null;
  return {
    id: data.id as string | undefined,
    username: data.username as string | undefined,
    follower_count: data.follower_count as number | undefined,
    media_count: data.media_count as number | undefined,
    following_count: data.following_count as number | undefined,
    is_private: data.is_private as boolean | undefined,
    is_new_to_instagram: data.is_new_to_instagram as boolean | undefined,
    full_name: data.full_name as string | undefined,
    biography: typeof data.biography === "string" ? (data.biography as string).slice(0, 80) : "",
    has_profile_pic: Boolean(data.profile_pic_url),
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = Math.min(20, Number(url.searchParams.get("n") ?? 10) || 10);
  const source = url.searchParams.get("source"); // 'big_account_followers' | 'random_username' | 'manual' | null

  const key = await getRapidApiKey();
  if (!key) return NextResponse.json({ error: "no rapidapi key" }, { status: 500 });

  const where: import("@prisma/client").Prisma.TestAccountWhereInput = {
    platform: "instagram",
    status: "available",
  };
  if (source) where.scrapeSource = source;

  // Random-ish sample via Prisma: order by id desc but offset random.
  const total = await prisma.testAccount.count({ where });
  const offset = total > n ? Math.floor(Math.random() * (total - n)) : 0;
  const rows = await prisma.testAccount.findMany({
    where,
    take: n,
    skip: offset,
    orderBy: { id: "desc" },
  });

  const results = await Promise.all(
    rows.map(async (r) => {
      const [byIdRapid, byUnameRapid, searchByUname, searchById] =
        await Promise.all([
          rapidCall(`/userinfo/?username_or_id=${encodeURIComponent(r.userId)}`, key),
          rapidCall(`/userinfo/?username_or_id=${encodeURIComponent(r.username)}`, key),
          igTopsearch(r.username),
          igTopsearch(r.userId),
        ]);

      const rapidById = extractRapidUser(byIdRapid.body);
      const rapidByUname = extractRapidUser(byUnameRapid.body);
      const igSearchUname = "hits" in searchByUname ? searchByUname.hits : null;
      const igSearchId = "hits" in searchById ? searchById.hits : null;

      const exactUsernameHit = igSearchUname?.find(
        (h) => h.username.toLowerCase() === r.username.toLowerCase()
      );
      const pkMatchesStoredId = exactUsernameHit?.pk === r.userId;

      return {
        stored: {
          id: r.id,
          username: r.username,
          userId: r.userId,
          scrapeSource: r.scrapeSource,
          lastFollowerCount: r.lastFollowerCount,
          lastMediaCount: r.lastMediaCount,
          lastFollowingCount: r.lastFollowingCount,
        },
        rapidapi: {
          byId: byIdRapid.status + " " + (rapidById ? JSON.stringify(rapidById).slice(0, 300) : String(byIdRapid.body).slice(0, 200)),
          byUsername: byUnameRapid.status + " " + (rapidByUname ? JSON.stringify(rapidByUname).slice(0, 300) : String(byUnameRapid.body).slice(0, 200)),
        },
        ig: {
          searchByUsername:
            "hits" in searchByUname
              ? {
                  hits: (igSearchUname ?? []).slice(0, 5).map((h) => ({
                    pk: h.pk,
                    username: h.username,
                  })),
                  exactUsernameFound: Boolean(exactUsernameHit),
                  exactUsernamePkMatchesStored: pkMatchesStoredId,
                }
              : searchByUname,
          searchByUserId:
            "hits" in searchById
              ? {
                  hits: (igSearchId ?? []).slice(0, 5).map((h) => ({
                    pk: h.pk,
                    username: h.username,
                  })),
                }
              : searchById,
        },
        verdict: (() => {
          if (!rapidById && !rapidByUname) return "rapidapi_says_not_found";
          if (exactUsernameHit && pkMatchesStoredId) return "VERIFIED_REAL";
          if (exactUsernameHit && !pkMatchesStoredId)
            return "username_exists_but_different_pk";
          if (!exactUsernameHit && rapidById) return "GHOST_rapidapi_claims_exists_ig_search_empty";
          return "unknown";
        })(),
      };
    })
  );

  return NextResponse.json({ total, sampleSize: rows.length, results });
}
