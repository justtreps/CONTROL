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
  // Endpoint pattern mirrors /userfollowers/?username_or_id=X — the
  // provider exposes /userinfo/?username_or_id=X for the per-account
  // profile stats. If this 404s on another tier we fall back to
  // /user_by_username/?username=X.
  let json: RawUserInfo;
  try {
    json = (await call(
      `/userinfo/?username_or_id=${encodeURIComponent(usernameOrId)}`
    )) as RawUserInfo;
  } catch (primary) {
    const msg = (primary as Error).message;
    if (/\b404\b/.test(msg) || /does not exist/i.test(msg)) {
      json = (await call(
        `/user_by_username/?username=${encodeURIComponent(usernameOrId)}`
      )) as RawUserInfo;
    } else {
      throw primary;
    }
  }

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

// ── Recent posts — engagement pool path ─────────────────────────────
// Shape used by the scraper when an account qualifies as engagement_
// test and we need to build its TestAccountMedia rows.

export type InstagramPost = {
  mediaId: string;       // platform-native id / pk
  shortcode: string;     // used to build https://www.instagram.com/p/{code}/
  mediaType: "post" | "reel";
  likeCount: number;
  takenAt: number | null; // epoch ms (null if provider didn't expose)
};

export type InstagramPostsResponse = {
  count: number;
  posts: InstagramPost[];
};

type RawUserPosts = {
  data?: {
    items?: Array<{
      id?: string | number;
      pk?: string | number;
      code?: string;
      shortcode?: string;
      like_count?: number;
      likes_count?: number;
      taken_at?: number | string;
      taken_at_timestamp?: number | string;
      media_type?: number; // 1=photo, 2=video/reel, 8=carousel
      product_type?: string; // "clips" for reels
    }>;
    count?: number;
  };
  items?: Array<unknown>;
};

// Fetch a small window of the most recent feed posts for a user id.
// We don't page further — we only need a few valid candidates to
// populate TestAccountMedia.
export async function fetchInstagramUserPosts(
  userId: string,
  count = 5
): Promise<InstagramPostsResponse> {
  const json = (await call(
    `/userposts/?username_or_id=${encodeURIComponent(userId)}&count=${count}`
  )) as RawUserPosts;

  const rawItems = json?.data?.items ?? [];
  const posts: InstagramPost[] = [];
  for (const raw of rawItems) {
    const mediaId = String(raw.pk ?? raw.id ?? "");
    const shortcode = String(raw.shortcode ?? raw.code ?? "");
    if (!mediaId || !shortcode) continue;
    const isReel = raw.product_type === "clips" || raw.media_type === 2;
    const likeCount = Number(raw.like_count ?? raw.likes_count ?? 0);
    const takenAtRaw = raw.taken_at ?? raw.taken_at_timestamp ?? null;
    const takenAt = takenAtRaw
      ? // IG returns either seconds (legacy) or millis depending on endpoint.
        // Normalize: < 1e12 means seconds, >= 1e12 means millis.
        Number(takenAtRaw) < 1e12
        ? Number(takenAtRaw) * 1000
        : Number(takenAtRaw)
      : null;
    posts.push({
      mediaId,
      shortcode,
      mediaType: isReel ? "reel" : "post",
      likeCount,
      takenAt,
    });
  }
  return {
    count: posts.length,
    posts,
  };
}

// Build the permalink from a shortcode. Reels use /reel/, feed posts
// use /p/. Picking the right one matters for BulkMedya — wrong URL
// shape = refund.
export function instagramPostUrl(post: InstagramPost): string {
  return post.mediaType === "reel"
    ? `https://www.instagram.com/reel/${post.shortcode}/`
    : `https://www.instagram.com/p/${post.shortcode}/`;
}
