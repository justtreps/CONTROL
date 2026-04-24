// Canonical list of MyBoost products. Source of truth for the seed
// endpoint + the matcher. Order here drives the order of cards on
// /config/catalogue.

export type ProductSeed = {
  slug: string;
  displayName: string;
  platform: "instagram" | "tiktok";
  productType: "followers" | "likes" | "views" | "shares" | "saves";
};

export const PRODUCT_SEEDS: ProductSeed[] = [
  {
    slug: "ig-followers",
    displayName: "Instagram Abonnés",
    platform: "instagram",
    productType: "followers",
  },
  {
    slug: "ig-likes",
    displayName: "Instagram Likes",
    platform: "instagram",
    productType: "likes",
  },
  {
    slug: "ig-views",
    displayName: "Instagram Vues",
    platform: "instagram",
    productType: "views",
  },
  {
    slug: "tt-followers",
    displayName: "TikTok Abonnés",
    platform: "tiktok",
    productType: "followers",
  },
  {
    slug: "tt-likes",
    displayName: "TikTok Likes",
    platform: "tiktok",
    productType: "likes",
  },
  {
    slug: "tt-views",
    displayName: "TikTok Vues",
    platform: "tiktok",
    productType: "views",
  },
  {
    slug: "tt-shares",
    displayName: "TikTok Partages",
    platform: "tiktok",
    productType: "shares",
  },
  {
    slug: "tt-saves",
    displayName: "TikTok Enregistrements",
    platform: "tiktok",
    productType: "saves",
  },
];
