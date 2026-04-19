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
    edge_followed_by?: {
      count?: number;
      edges?: Array<{ node?: Partial<InstagramFollower> }>;
    };
  };
};

export async function fetchInstagramFollowers(
  usernameOrId: string
): Promise<InstagramFollowersResponse> {
  const json = (await call(
    `/userfollowers/?username_or_id=${encodeURIComponent(usernameOrId)}`
  )) as RawFollowersResponse;

  const data = json?.data?.edge_followed_by;
  if (!data || typeof data.count !== "number") {
    throw new Error(
      `Unexpected Instagram response: ${JSON.stringify(json).slice(0, 200)}`
    );
  }

  const sample: InstagramFollower[] = (data.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is InstagramFollower => Boolean(n && n.id))
    .slice(0, 20);

  return { count: data.count, sample };
}
