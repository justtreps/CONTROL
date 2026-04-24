// Minimal cron-expression evaluator — matches the 5-field syntax
// (minute, hour, dom, month, dow) against a Date. We don't need the
// full croniter grammar (no macros, no step-lists), just the subset
// Vercel cron supports. Deliberately tiny so the master executor
// cron can fire at most every minute without importing a heavy dep.

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // dom
  [1, 12], // month
  [0, 6],  // dow (0 = Sun)
];

type Matcher = (v: number) => boolean;

function parseField(raw: string, [min, max]: [number, number]): Matcher {
  if (raw === "*") return () => true;
  // */5 — every N starting from min
  if (raw.startsWith("*/")) {
    const step = Number(raw.slice(2));
    if (!Number.isFinite(step) || step <= 0) return () => false;
    return (v) => (v - min) % step === 0;
  }
  // N,M,O — explicit set
  if (raw.includes(",")) {
    const set = new Set(
      raw
        .split(",")
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n) && n >= min && n <= max)
    );
    return (v) => set.has(v);
  }
  // N-M — inclusive range
  if (raw.includes("-")) {
    const [a, b] = raw.split("-").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return () => false;
    return (v) => v >= a && v <= b;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return () => false;
  return (v) => v === n;
}

export function cronMatches(expr: string, at: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const matchers = fields.map((f, i) => parseField(f, FIELD_RANGES[i]));
  // UTC reads so we're aligned with Vercel cron (which runs UTC).
  const minute = at.getUTCMinutes();
  const hour = at.getUTCHours();
  const dom = at.getUTCDate();
  const month = at.getUTCMonth() + 1;
  const dow = at.getUTCDay();
  return (
    matchers[0](minute) &&
    matchers[1](hour) &&
    matchers[2](dom) &&
    matchers[3](month) &&
    matchers[4](dow)
  );
}
