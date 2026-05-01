// Pool oracle — single source of truth for "does this user_id still
// exist and what are its fresh counts?".
//
// IG: RapidAPI /userinfo/?username_or_id={userId}
//   - {data:{...}} → ok
//   - {detail:"Not found"} → ghost
//   - other shapes → transient error
//
// TT: RapidAPI /user/info?user_id={userId}
//   - {code:0, data:{user, stats}} → ok
//   - {code:-1, msg:"... Not found"} → ghost
//   - other → error
//
// Used at three spots:
//   1. Scrape cross-validation (FIX 1)
//   2. Daily health-check (FIX 2)
//   3. Baseline-at-placement in the test-bot (FIX baseline)

import { fetchInstagramUserInfo } from "@/lib/rapidapi/instagram";
import { fetchTikTokUserByUserId } from "@/lib/rapidapi/tiktok";

export type OracleOk = {
  ok: true;
  platform: "instagram" | "tiktok";
  userId: string;
  username: string;
  followerCount: number;
  followingCount: number;
  mediaCount: number;
  isPrivate: boolean;
};

export type OracleMiss = {
  ok: false;
  reason: "ghost" | "error";
  message: string;
};

export type OracleResult = OracleOk | OracleMiss;

// Patterns that unambiguously mean "this IG user_id doesn't resolve
// to a live account" (deleted, banned, or never existed). Any hit →
// ghost. Kept broad because RapidAPI has changed its error shapes
// over time and various upstream/downstream layers rephrase the
// response (e.g. some proxies wrap a 404 as a 200 with an HTML body).
const IG_GHOST_RX = [
  /"detail"\s*:\s*"Not found"/i,     // native RapidAPI error shape
  /\buser not found\b/i,              // common upstream rewording
  /\bdoes not exist\b/i,              // alt IG API wording
  /\baccount (?:has been )?removed\b/i,
  /\bno user (?:was )?found\b/i,
  /\b404\b/,                          // raw HTTP 404 leak in msg
];

function igIsGhost(msg: string): boolean {
  if (IG_GHOST_RX.some((rx) => rx.test(msg))) return true;
  // Paired condition: generic "not found" text inside a user_info
  // error body (avoids false positives on e.g. "followers not found").
  if (/not found/i.test(msg) && /user_info/i.test(msg)) return true;
  return false;
}

export async function fetchIgOracle(userId: string): Promise<OracleResult> {
  try {
    const info = await fetchInstagramUserInfo(userId);
    return {
      ok: true,
      platform: "instagram",
      userId: info.userId || userId,
      username: info.username,
      followerCount: info.followerCount,
      followingCount: info.followingCount,
      mediaCount: info.mediaCount,
      isPrivate: info.isPrivate,
    };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (igIsGhost(msg)) {
      return { ok: false, reason: "ghost", message: msg.slice(0, 200) };
    }
    return { ok: false, reason: "error", message: msg.slice(0, 200) };
  }
}

// TT: most ghost signals are already captured upstream (fetchTikTokUser
// ByUserId returns null on the obvious ones), but the helper can still
// throw if the provider returns an unexpected shape. Broaden ghost
// detection on the thrown-message path too for parity with IG.
const TT_GHOST_RX = [
  /\bnot found\b/i,
  /\buserinfo is failed\b/i,
  /\bunique_id is invalid\b/i,
  /\buser does not exist\b/i,
  /\b404\b/,
];

function ttIsGhost(msg: string): boolean {
  return TT_GHOST_RX.some((rx) => rx.test(msg));
}

export async function fetchTtOracle(userId: string): Promise<OracleResult> {
  try {
    const info = await fetchTikTokUserByUserId(userId);
    if (!info) {
      return { ok: false, reason: "ghost", message: "user_id not found on tiktok" };
    }
    return {
      ok: true,
      platform: "tiktok",
      userId: info.userId || userId,
      username: info.uniqueId,
      followerCount: info.followerCount,
      followingCount: info.followingCount,
      mediaCount: info.mediaCount,
      isPrivate: false, // TT public API doesn't expose is_private for this shape
    };
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (ttIsGhost(msg)) {
      return { ok: false, reason: "ghost", message: msg.slice(0, 200) };
    }
    return { ok: false, reason: "error", message: msg.slice(0, 200) };
  }
}

export async function fetchOracleFor(
  platform: string,
  userId: string
): Promise<OracleResult> {
  if (platform === "instagram") return fetchIgOracle(userId);
  if (platform === "tiktok") return fetchTtOracle(userId);
  return { ok: false, reason: "error", message: `unsupported platform: ${platform}` };
}

// ── POST oracle (engagement tests) ─────────────────────────────────
// Engagement TestOrders need fresh per-post counts for likes/views/
// comments/shares/saves to compute deliveredQty = current - baseline.
// Both providers expose these via the user-posts list endpoint, so we
// fetch the parent's recent N posts (1 RapidAPI call) and pivot to the
// target post by mediaId.
//
// Limitation: if the post drifts past the recent N (parent posted a
// lot since), we'll miss it and return ghost. Bump the count cap if
// engagement tests start flagging spurious ghosts. For follower flow
// we never had this concern since we read the parent's own counts
// directly.

import { fetchInstagramUserPosts } from "@/lib/rapidapi/instagram";
import { fetchTikTokUserVideos } from "@/lib/rapidapi/tiktok";

export type PostMetric = "likes" | "views" | "comments" | "shares" | "saves";

export type PostOracleOk = {
  ok: true;
  platform: "instagram" | "tiktok";
  mediaId: string;
  // Counts surfaced per platform. Only the metric the caller asked for
  // is guaranteed non-null on platforms that don't expose every field
  // (e.g. IG view_count is video-only). Caller routes via PostMetric.
  likeCount: number;
  commentCount: number | null;
  viewCount: number | null;
  shareCount: number | null;
  saveCount: number | null;
};

export type PostOracleResult =
  | PostOracleOk
  | { ok: false; reason: "ghost" | "error" | "metric_unavailable"; message: string };

const POST_LOOKUP_COUNT = 30;

/**
 * Resolve a specific media's current engagement counts. The caller
 * passes the parent userId (so we know which feed to fetch) AND the
 * mediaId (so we can pivot in the response). Returns ghost if the
 * post is gone from the recent feed (likely deleted) or if the parent
 * itself errors out.
 */
export async function fetchPostOracle(
  platform: string,
  parentUserId: string,
  mediaId: string,
): Promise<PostOracleResult> {
  if (platform === "instagram") {
    try {
      const res = await fetchInstagramUserPosts(parentUserId, POST_LOOKUP_COUNT);
      const hit = res.posts.find((p) => p.mediaId === mediaId);
      if (!hit) {
        return {
          ok: false,
          reason: "ghost",
          message: `post ${mediaId} not in recent ${POST_LOOKUP_COUNT} of @${parentUserId}`,
        };
      }
      return {
        ok: true,
        platform: "instagram",
        mediaId: hit.mediaId,
        likeCount: hit.likeCount,
        commentCount: hit.commentCount,
        // IG: prefer view_count (image+video), fall back to play_count (reels).
        viewCount: hit.viewCount ?? hit.playCount,
        shareCount: null, // IG doesn't expose share count per post on this endpoint
        saveCount: null, // IG save count is rarely surfaced; leave null until we have a reliable source
      };
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (igIsGhost(msg)) {
        return { ok: false, reason: "ghost", message: msg.slice(0, 200) };
      }
      return { ok: false, reason: "error", message: msg.slice(0, 200) };
    }
  }
  if (platform === "tiktok") {
    try {
      const res = await fetchTikTokUserVideos(parentUserId, POST_LOOKUP_COUNT);
      const hit = res.videos.find((v) => v.mediaId === mediaId);
      if (!hit) {
        return {
          ok: false,
          reason: "ghost",
          message: `video ${mediaId} not in recent ${POST_LOOKUP_COUNT} of user_id=${parentUserId}`,
        };
      }
      return {
        ok: true,
        platform: "tiktok",
        mediaId: hit.mediaId,
        likeCount: hit.likeCount,
        commentCount: hit.commentCount,
        viewCount: hit.playCount,
        shareCount: hit.shareCount,
        saveCount: hit.saveCount,
      };
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (ttIsGhost(msg)) {
        return { ok: false, reason: "ghost", message: msg.slice(0, 200) };
      }
      return { ok: false, reason: "error", message: msg.slice(0, 200) };
    }
  }
  return {
    ok: false,
    reason: "error",
    message: `unsupported platform: ${platform}`,
  };
}

/**
 * Map the Service.serviceType (likes / views / shares / saves /
 * comments) to the corresponding count on a PostOracleOk. Returns
 * null when the platform doesn't expose that metric on this endpoint
 * (e.g. IG share / save) so the caller can fall back to an
 * abort_metric_unavailable rather than measuring the wrong number.
 */
export function pickPostMetric(
  oracle: PostOracleOk,
  metric: PostMetric,
): number | null {
  switch (metric) {
    case "likes":
      return oracle.likeCount;
    case "views":
      return oracle.viewCount;
    case "comments":
      return oracle.commentCount;
    case "shares":
      return oracle.shareCount;
    case "saves":
      return oracle.saveCount;
    default:
      return null;
  }
}

/**
 * Normalise Service.serviceType → PostMetric. The classifier already
 * narrows serviceType to one of {followers, likes, views, shares,
 * saves}, but the column is `String` and historic rows may carry
 * casing or alias variants. Keep this single source of truth so the
 * placement and poller agree.
 */
export function metricFromServiceType(serviceType: string): PostMetric | null {
  const s = serviceType.toLowerCase().trim();
  if (s === "likes" || s === "like") return "likes";
  if (s === "views" || s === "view" || s === "plays" || s === "play") return "views";
  if (s === "comments" || s === "comment") return "comments";
  if (s === "shares" || s === "share") return "shares";
  if (s === "saves" || s === "save" || s === "bookmarks" || s === "favorites") return "saves";
  return null;
}
