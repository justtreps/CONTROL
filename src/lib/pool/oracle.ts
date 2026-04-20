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
    // Our helper throws "Unexpected Instagram user_info response: {detail:'Not found'}..."
    // when RapidAPI says the user_id doesn't exist. Match that signature explicitly.
    if (/"detail"\s*:\s*"Not found"/i.test(msg) || /not found/i.test(msg) && /user_info/i.test(msg)) {
      return { ok: false, reason: "ghost", message: msg.slice(0, 200) };
    }
    return { ok: false, reason: "error", message: msg.slice(0, 200) };
  }
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
    return {
      ok: false,
      reason: "error",
      message: (e as Error).message.slice(0, 200),
    };
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
