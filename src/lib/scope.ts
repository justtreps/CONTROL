// CONTROL — MVP scope config.
//
// Single source of truth for:
// - which platforms are surfaced in the UI (tabs on /services)
// - which service types each platform exposes
// - which (platform, type) pairs are actually wired end-to-end in the
//   current MVP (synced from BulkMedya, scored, routed)
//
// Lifting the MVP restriction = flip `mvp: true` here AND lift the filter
// in lib/bulkmedya.ts:syncServices().

export type ServiceTypeId =
  | "followers"
  | "likes"
  | "views"
  | "comments"
  | "shares"
  | "saves"
  | "stories"
  | "live_viewers"
  | "other";

export type PlatformId =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "twitter"
  | "spotify";

export type ServiceTypeCfg = {
  id: ServiceTypeId;
  label: string;
  mvp: boolean;
};

export type PlatformCfg = {
  id: PlatformId;
  label: string;
  enabled: boolean;
  types: ServiceTypeCfg[];
};

export const SCOPE: { platforms: PlatformCfg[] } = {
  platforms: [
    {
      id: "instagram",
      label: "Instagram",
      enabled: true,
      types: [
        { id: "followers", label: "Followers", mvp: true },
        { id: "likes", label: "Likes", mvp: false },
        { id: "views", label: "Views", mvp: false },
        { id: "comments", label: "Comments", mvp: false },
        { id: "saves", label: "Saves", mvp: false },
        { id: "stories", label: "Stories", mvp: false },
        { id: "live_viewers", label: "Live viewers", mvp: false },
      ],
    },
    {
      id: "tiktok",
      label: "TikTok",
      enabled: true,
      types: [
        { id: "followers", label: "Followers", mvp: true },
        { id: "likes", label: "Likes", mvp: false },
        { id: "views", label: "Views", mvp: false },
        { id: "shares", label: "Shares", mvp: false },
        { id: "comments", label: "Comments", mvp: false },
        { id: "live_viewers", label: "Live viewers", mvp: false },
      ],
    },
    {
      id: "youtube",
      label: "YouTube",
      enabled: false,
      types: [
        { id: "followers", label: "Subscribers", mvp: false },
        { id: "views", label: "Views", mvp: false },
        { id: "likes", label: "Likes", mvp: false },
      ],
    },
    {
      id: "twitter",
      label: "Twitter/X",
      enabled: false,
      types: [
        { id: "followers", label: "Followers", mvp: false },
        { id: "likes", label: "Likes", mvp: false },
      ],
    },
    {
      id: "spotify",
      label: "Spotify",
      enabled: false,
      types: [
        { id: "followers", label: "Followers", mvp: false },
        { id: "views", label: "Plays", mvp: false },
      ],
    },
  ],
};

export function isMvpPair(platform: string, serviceType: string): boolean {
  const p = SCOPE.platforms.find((x) => x.id === platform);
  if (!p || !p.enabled) return false;
  const t = p.types.find((x) => x.id === serviceType);
  return Boolean(t?.mvp);
}

export function getPlatform(id: string): PlatformCfg | undefined {
  return SCOPE.platforms.find((p) => p.id === id);
}

export function getMvpTypes(platformId: string): ServiceTypeCfg[] {
  const p = getPlatform(platformId);
  if (!p) return [];
  return p.types.filter((t) => t.mvp);
}

// Default landing selection on /services when no params are given.
export const DEFAULT_PLATFORM: PlatformId = "instagram";
export const DEFAULT_TYPE: ServiceTypeId = "followers";
