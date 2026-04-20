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
