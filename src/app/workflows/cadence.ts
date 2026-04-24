// Rough French label for a 5-field cron expression. Shared between
// the server-rendered detail page and the client-rendered list card.

export function cadenceLabel(expr: string | null | undefined): string {
  if (!expr) return "—";
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [m, h, dom, , ] = parts;
  if (m === "*" && h === "*" && dom === "*") return "chaque minute";
  if (m === "0" && h === "*" && dom === "*") return "chaque heure";
  if (m === "0" && h.startsWith("*/")) {
    const step = h.slice(2);
    return `toutes les ${step}h`;
  }
  if (m.startsWith("*/")) {
    const step = m.slice(2);
    return `toutes les ${step} min`;
  }
  if (m === "0" && /^\d+$/.test(h) && dom === "*") {
    return `quotidien à ${h.padStart(2, "0")}:00 UTC`;
  }
  return expr;
}
