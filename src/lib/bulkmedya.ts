import { getBulkmedyaKey } from "@/lib/config";
import { prisma } from "@/lib/prisma";

const BULKMEDYA_URL = process.env.BULKMEDYA_API_URL ?? "https://bulkmedya.org/api/v2";

type RawService = {
  service: string | number;
  name: string;
  type?: string;
  category?: string;
  rate: string | number;
  min: string | number;
  max: string | number;
  refill?: boolean;
  cancel?: boolean;
};

export type BulkmedyaOrderResponse = { order: number } | { error: string };

async function bulkmedyaPost<T>(params: Record<string, string | number>): Promise<T> {
  const key = await getBulkmedyaKey();
  if (!key) throw new Error("BulkMedya API key not configured");

  const body = new URLSearchParams({ key, ...Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ) });

  const res = await fetch(BULKMEDYA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`BulkMedya HTTP ${res.status}: ${await res.text()}`);
  }

  return (await res.json()) as T;
}

const PLATFORM_KEYWORDS: Array<[string, string[]]> = [
  ["instagram", ["instagram", "insta ", "ig "]],
  ["tiktok", ["tiktok", "tik tok", "tik-tok"]],
  ["youtube", ["youtube", "yt "]],
  ["twitter", ["twitter", "x.com"]],
  ["facebook", ["facebook", "fb "]],
  ["telegram", ["telegram"]],
  ["spotify", ["spotify"]],
];

const TYPE_KEYWORDS: Array<[string, string[]]> = [
  ["followers", ["followers", "follower", "subscribers", "subs"]],
  ["likes", ["likes", "like"]],
  ["views", ["views", "view", "plays", "play"]],
  ["comments", ["comments", "comment"]],
  ["shares", ["shares", "share", "reposts"]],
  ["saves", ["saves", "save", "bookmark"]],
];

function classify(name: string, category: string) {
  const haystack = `${name} ${category}`.toLowerCase();
  let platform = "unknown";
  for (const [p, kws] of PLATFORM_KEYWORDS) {
    if (kws.some((k) => haystack.includes(k))) {
      platform = p;
      break;
    }
  }
  let serviceType = "other";
  for (const [t, kws] of TYPE_KEYWORDS) {
    if (kws.some((k) => haystack.includes(k))) {
      serviceType = t;
      break;
    }
  }
  return { platform, serviceType };
}

export async function fetchServices(): Promise<RawService[]> {
  return bulkmedyaPost<RawService[]>({ action: "services" });
}

export type SyncResult = {
  total: number;
  created: number;
  updated: number;
  deactivated: number;
};

export async function syncServices(): Promise<SyncResult> {
  const raw = await fetchServices();
  if (!Array.isArray(raw)) {
    throw new Error(`Unexpected services response: ${JSON.stringify(raw).slice(0, 200)}`);
  }

  const seenIds = new Set<number>();
  let created = 0;
  let updated = 0;

  for (const r of raw) {
    const bulkmedyaId = Number(r.service);
    if (!Number.isFinite(bulkmedyaId)) continue;
    seenIds.add(bulkmedyaId);

    const { platform, serviceType } = classify(r.name, r.category ?? "");

    const data = {
      bulkmedyaId,
      name: r.name,
      category: r.category ?? "",
      platform,
      serviceType,
      ratePerK: Number(r.rate) || 0,
      minQuantity: Number(r.min) || 0,
      maxQuantity: Number(r.max) || 0,
      refillSupported: Boolean(r.refill),
      cancelSupported: Boolean(r.cancel),
      active: true,
    };

    const existing = await prisma.service.findUnique({ where: { bulkmedyaId } });
    if (existing) {
      await prisma.service.update({ where: { bulkmedyaId }, data });
      updated++;
    } else {
      await prisma.service.create({ data });
      created++;
    }
  }

  // Deactivate services no longer listed
  const deactivated = await prisma.service.updateMany({
    where: {
      active: true,
      bulkmedyaId: { notIn: Array.from(seenIds) },
    },
    data: { active: false },
  });

  return {
    total: raw.length,
    created,
    updated,
    deactivated: deactivated.count,
  };
}

export async function placeOrder(params: {
  service: number;
  link: string;
  quantity: number;
}): Promise<BulkmedyaOrderResponse> {
  return bulkmedyaPost<BulkmedyaOrderResponse>({
    action: "add",
    service: params.service,
    link: params.link,
    quantity: params.quantity,
  });
}
