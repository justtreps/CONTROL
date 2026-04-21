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
