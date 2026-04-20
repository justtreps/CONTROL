import { getRapidApiKey } from "@/lib/config";

const HOST = "instagram-scraper-20251.p.rapidapi.com";

export type InstagramFollower = {
  id: string;
  username: string;
  full_name: string;
  profile_pic_url: string;
  is_private: boolean;
  is_verified: boolean;
};

export type InstagramFollowersResponse = {
  count: number;
  sample: InstagramFollower[];
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
    throw new Error(`Instagram RapidAPI ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

type RawFollowersResponse = {
  data?: {
    // Legacy shape — graphql-style
    edge_followed_by?: {
      count?: number;
      edges?: Array<{ node?: Partial<InstagramFollower> }>;
    };
    // Current shape — flat items[] with count sibling
    count?: number;
    items?: Array<Partial<InstagramFollower> & { pk?: string }>;
  };
};

export async function fetchInstagramFollowers(
  usernameOrId: string
): Promise<InstagramFollowersResponse> {
  const json = (await call(
    `/userfollowers/?username_or_id=${encodeURIComponent(usernameOrId)}`
  )) as RawFollowersResponse;

  // Support both legacy (edge_followed_by) and current (items[]) shapes.
  const legacy = json?.data?.edge_followed_by;
  const flat = json?.data;

  let count: number | undefined;
  let sample: InstagramFollower[] = [];

  if (legacy && typeof legacy.count === "number") {
    count = legacy.count;
    sample = (legacy.edges ?? [])
      .map((e) => e.node)
      .filter((n): n is InstagramFollower => Boolean(n && n.id))
      .slice(0, 20);
  } else if (flat && Array.isArray(flat.items)) {
    count = typeof flat.count === "number" ? flat.count : flat.items.length;
    sample = flat.items
      .map((it) => {
        // `pk` is sometimes the numeric id in the flat shape
        const id = it.id ?? it.pk;
        if (!id || !it.username) return null;
        return {
          id: String(id),
          username: it.username,
          full_name: it.full_name ?? "",
          profile_pic_url: it.profile_pic_url ?? "",
          is_private: Boolean(it.is_private),
          is_verified: Boolean(it.is_verified),
        } as InstagramFollower;
      })
      .filter((n): n is InstagramFollower => n !== null)
      .slice(0, 20);
  } else {
    throw new Error(
      `Unexpected Instagram response: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  if (typeof count !== "number") {
    throw new Error(
      `Unexpected Instagram response (no count): ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  return { count, sample };
}

// Per-account profile info used by the pool scraper to validate that
// a candidate is "near-virgin" before inserting. One call per candidate
// (pre-filtered by is_private / is_verified upstream to save quota).
export type InstagramUserInfo = {
  userId: string;
  username: string;
  followerCount: number;
  followingCount: number;
  mediaCount: number;
  isPrivate: boolean;
  isVerified: boolean;
};

type RawUserInfo = {
  data?: {
    // Legacy graphql shape
    edge_followed_by?: { count?: number };
    edge_follow?: { count?: number };
    edge_owner_to_timeline_media?: { count?: number };
    is_private?: boolean;
    is_verified?: boolean;
    id?: string;
    username?: string;
    // Flat shape — mirrors the /userfollowers/ items[] style
    pk?: string;
    pk_id?: string;
    full_name?: string;
    follower_count?: number;
    following_count?: number;
    media_count?: number;
    // Some endpoints nest user under data.user
    user?: {
      pk?: string;
      pk_id?: string;
      id?: string;
      username?: string;
      follower_count?: number;
      following_count?: number;
      media_count?: number;
      is_private?: boolean;
      is_verified?: boolean;
    };
  };
  // Some endpoints return top-level user stats
  follower_count?: number;
  following_count?: number;
  media_count?: number;
  is_private?: boolean;
  is_verified?: boolean;
  pk?: string;
  username?: string;
};

function pickString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function pickNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function fetchInstagramUserInfo(
  usernameOrId: string
): Promise<InstagramUserInfo> {
  // The scraper API exposes /user/?username_or_id=X or /user_by_username/
  // depending on the version. Use the same base path convention as the
  // followers call — /user/?username_or_id=X. If the shape doesn't match
  // we throw and the caller counts it as fetch_info_failed.
  const json = (await call(
    `/user/?username_or_id=${encodeURIComponent(usernameOrId)}`
  )) as RawUserInfo;

  // Try, in order: data.user.*, data.*, top-level
  const d = json?.data ?? {};
  const u = d.user ?? {};

  const followerCount =
    pickNumber(u.follower_count) ??
    pickNumber(d.follower_count) ??
    pickNumber(d.edge_followed_by?.count) ??
    pickNumber(json.follower_count);

  const followingCount =
    pickNumber(u.following_count) ??
    pickNumber(d.following_count) ??
    pickNumber(d.edge_follow?.count) ??
    pickNumber(json.following_count);

  const mediaCount =
    pickNumber(u.media_count) ??
    pickNumber(d.media_count) ??
    pickNumber(d.edge_owner_to_timeline_media?.count) ??
    pickNumber(json.media_count);

  if (
    followerCount === null ||
    followingCount === null ||
    mediaCount === null
  ) {
    throw new Error(
      `Unexpected Instagram user_info response: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  const userId =
    pickString(u.id) ||
    pickString(u.pk) ||
    pickString(u.pk_id) ||
    pickString(d.id) ||
    pickString(d.pk) ||
    pickString(d.pk_id) ||
    pickString(json.pk) ||
    "";
  const username =
    pickString(u.username) || pickString(d.username) || pickString(json.username) || usernameOrId;

  return {
    userId: userId || username,
    username,
    followerCount,
    followingCount,
    mediaCount,
    isPrivate: Boolean(u.is_private ?? d.is_private ?? json.is_private),
    isVerified: Boolean(u.is_verified ?? d.is_verified ?? json.is_verified),
  };
}
