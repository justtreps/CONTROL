import { prisma } from "@/lib/prisma";

export type ConfigKey =
  | "bulkmedya_api_key"
  | "rapidapi_key"
  | "scoring_weights";

export type ScoringWeights = {
  realism: number;
  speed: number;
  drop: number;
  dropWindowDays: number;
};

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  realism: 0.4,
  speed: 0.3,
  drop: 0.3,
  dropWindowDays: 7,
};

export async function getConfig<T = unknown>(key: ConfigKey): Promise<T | null> {
  const row = await prisma.config.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? null;
}

export async function setConfig(key: ConfigKey, value: unknown): Promise<void> {
  await prisma.config.upsert({
    where: { key },
    create: { key, value: value as object },
    update: { value: value as object },
  });
}

export async function getBulkmedyaKey(): Promise<string | null> {
  return (
    (await getConfig<string>("bulkmedya_api_key")) ??
    process.env.BULKMEDYA_API_KEY ??
    null
  );
}

export async function getRapidApiKey(): Promise<string | null> {
  return (
    (await getConfig<string>("rapidapi_key")) ??
    process.env.RAPIDAPI_KEY ??
    null
  );
}

export async function getScoringWeights(): Promise<ScoringWeights> {
  return (
    (await getConfig<ScoringWeights>("scoring_weights")) ??
    DEFAULT_SCORING_WEIGHTS
  );
}
