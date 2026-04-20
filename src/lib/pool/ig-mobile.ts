// Instagram mobile-app API helper — used as a free, reliable oracle
// for "does this user still exist and what is its current username?".
//
// Endpoint:  https://i.instagram.com/api/v1/users/{user_id}/info/
//   200 → { user: { pk, username, full_name, follower_count,
//                    following_count, media_count, is_private, ... } }
//   404 → { message: "User not found", status: "fail",
//           error_type: "user_not_found" }
//
// No RapidAPI involved, no quota (so far). Requires a mobile UA header
// + x-ig-app-id. We accept this as semi-public unsanctioned IG surface.

const HOST = "https://i.instagram.com";
const UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x2137; samsung; SM-G950F; dreamlte; samsungexynos8895; en_US; 450281742)";
const APP_ID = "936619743392459";

export type IgMobileUser = {
  userId: string;
  username: string;
  followerCount: number;
  followingCount: number;
  mediaCount: number;
  isPrivate: boolean;
  isVerified: boolean;
};

export type IgMobileResult =
  | { ok: true; user: IgMobileUser }
  | { ok: false; reason: "deleted" | "http_error" | "bad_payload"; status: number; message: string };

export async function fetchIgMobileUserInfo(
  userId: string
): Promise<IgMobileResult> {
  let res: Response;
  try {
    res = await fetch(`${HOST}/api/v1/users/${encodeURIComponent(userId)}/info/`, {
      headers: {
        "user-agent": UA,
        "x-ig-app-id": APP_ID,
        accept: "*/*",
      },
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      reason: "http_error",
      status: 0,
      message: (e as Error).message,
    };
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "bad_payload",
      status: res.status,
      message: text.slice(0, 200),
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      reason: "deleted",
      status: 404,
      message:
        (json as { message?: string })?.message ?? "user_not_found",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      reason: "http_error",
      status: res.status,
      message:
        (json as { message?: string })?.message ?? `HTTP ${res.status}`,
    };
  }

  const u = (json as { user?: Record<string, unknown> })?.user;
  if (!u || typeof u !== "object") {
    return {
      ok: false,
      reason: "bad_payload",
      status: res.status,
      message: String(text).slice(0, 200),
    };
  }

  const pickStr = (v: unknown): string =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  const pickNum = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  return {
    ok: true,
    user: {
      userId: pickStr(u.pk) || pickStr(u.id) || userId,
      username: pickStr(u.username),
      followerCount: pickNum(u.follower_count),
      followingCount: pickNum(u.following_count),
      mediaCount: pickNum(u.media_count),
      isPrivate: Boolean(u.is_private),
      isVerified: Boolean(u.is_verified),
    },
  };
}
