import { getRapidApiKey } from "@/lib/config";

const HOST = "tiktok-scraper7.p.rapidapi.com";

export type TikTokFollower = {
  id: string;
  unique_id: string;
  nickname: string;
  signature: string;
  avatar: string;
  aweme_count: number;
  following_count: number;
  follower_count: number;
};

export type TikTokFollowersResponse = {
  count: number;
  sample: TikTokFollower[];
};

async function call(path: string): Promise<unknown> {
  const key = await getRapidApiKey();
  if (!key) throw new Error("RapidAPI key not configured");

  const res = await fetch(`https://${HOST}${path}`, {
    headers: {
      "x-rapidapi-key": key,
      "x-rapidapi-host": HOST,
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TikTok RapidAPI ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

type RawFollowersResponse = {
  code?: number;
  data?: {
    followers?: Array<Partial<TikTokFollower>>;
    total?: number;
  };
};

export async function fetchTikTokFollowers(
  userId: string
): Promise<TikTokFollowersResponse> {
  const json = (await call(
    `/user/followers?user_id=${encodeURIComponent(userId)}&count=100&time=0`
  )) as RawFollowersResponse;

  if (json?.code !== 0 || !json.data) {
    throw new Error(
      `Unexpected TikTok response: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  const sample: TikTokFollower[] = (json.data.followers ?? [])
    .filter((f): f is TikTokFollower => Boolean(f && f.id))
    .slice(0, 20);

  return { count: json.data.total ?? 0, sample };
}

// Resolve a @handle to its numeric user_id (+ profile stats). Used by
// the pool scraper to convert seed usernames before calling the
// followers endpoint.
type RawUserInfo = {
  code?: number;
  data?: {
    user?: {
      id?: string;
      unique_id?: string;
      nickname?: string;
      follower_count?: number;
      following_count?: number;
      aweme_count?: number;
      signature?: string;
    };
    stats?: {
      followerCount?: number;
      followingCount?: number;
      videoCount?: number;
    };
  };
};

export type TikTokUserInfo = {
  userId: string;
  uniqueId: string;
  followerCount: number;
  followingCount: number;
  mediaCount: number;
};

export async function fetchTikTokUserByUsername(
  username: string
): Promise<TikTokUserInfo> {
  const json = (await call(
    `/user/info?unique_id=${encodeURIComponent(username)}`
  )) as RawUserInfo;

  const u = json?.data?.user;
  const s = json?.data?.stats;
  if (!u || !u.id) {
    throw new Error(
      `Unexpected TikTok user response: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  return {
    userId: u.id,
    uniqueId: u.unique_id ?? username,
    followerCount: s?.followerCount ?? u.follower_count ?? 0,
    followingCount: s?.followingCount ?? u.following_count ?? 0,
    mediaCount: s?.videoCount ?? u.aweme_count ?? 0,
  };
}

// Resolve by numeric user_id. Used by the pool oracle to verify that
// a follower returned by /user/followers still exists under the same
// stable id + fetch fresh counts. Returns null on 404-ish responses
// so the caller can reject as 'ghost' cleanly.
export async function fetchTikTokUserByUserId(
  userId: string
): Promise<TikTokUserInfo | null> {
  const json = (await call(
    `/user/info?user_id=${encodeURIComponent(userId)}`
  )) as RawUserInfo & { msg?: string };

  if (json?.code !== 0) {
    // TikTok wraps errors in { code: -1, msg: "..." }
    const msg = (json.msg ?? "").toString().toLowerCase();
    if (msg.includes("not found") || msg.includes("userinfo is failed")) {
      return null;
    }
    throw new Error(
      `Unexpected TikTok user response: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  const u = json?.data?.user;
  const s = json?.data?.stats;
  if (!u || !u.id) return null;

  return {
    userId: u.id,
    uniqueId: u.unique_id ?? "",
    followerCount: s?.followerCount ?? u.follower_count ?? 0,
    followingCount: s?.followingCount ?? u.following_count ?? 0,
    mediaCount: s?.videoCount ?? u.aweme_count ?? 0,
  };
}
