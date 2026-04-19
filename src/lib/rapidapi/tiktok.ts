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
