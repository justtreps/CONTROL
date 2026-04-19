import { fetchInstagramFollowers } from "./instagram";
import { fetchTikTokFollowers } from "./tiktok";
import {
  computeInstagramRealism,
  computeTikTokRealism,
  type RealismBreakdown,
} from "./realism";

export type Platform = "instagram" | "tiktok";

export type FollowerSnapshot = {
  count: number;
  realismScore: number;
  realismData: RealismBreakdown;
};

export async function fetchFollowerSnapshot(
  platform: Platform,
  username: string,
  userId: string
): Promise<FollowerSnapshot> {
  if (platform === "instagram") {
    const { count, sample } = await fetchInstagramFollowers(username || userId);
    const { score, breakdown } = computeInstagramRealism(sample);
    return { count, realismScore: score, realismData: breakdown };
  }
  if (platform === "tiktok") {
    const { count, sample } = await fetchTikTokFollowers(userId);
    const { score, breakdown } = computeTikTokRealism(sample);
    return { count, realismScore: score, realismData: breakdown };
  }
  throw new Error(`Unsupported platform for scraping: ${platform}`);
}

export type { RealismBreakdown } from "./realism";
export type { InstagramFollower } from "./instagram";
export type { TikTokFollower } from "./tiktok";
