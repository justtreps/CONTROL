// Shared types for the alert system.
//
// A Detector returns zero or more DetectorResult rows on each tick.
// The engine (src/lib/alerts/engine.ts) reconciles these against the
// Alert table: create if new code, bump triggerCount if already
// active, auto_resolve active rows whose code is absent from the
// current result set.

export type AlertCategory =
  | "infra"
  | "pool"
  | "job"
  | "catalogue"
  | "business"
  | "rapidapi"
  | "testbot";

export type AlertSeverity = "info" | "warning" | "critical";

export type ActionType = "link" | "button";

export type ActionPayload = {
  // 'link' variant
  href?: string;
  // 'button' variant
  endpoint?: string;
  method?: "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  // Common
  confirm?: string; // optional confirmation dialog text
};

export type DetectorResult = {
  /**
   * Deterministic, semantic identifier. Include parameters that
   * distinguish per-instance alerts, e.g.
   *   "pool_below_min:instagram:follower"
   *   "job_stuck:63"
   *   "key_near_cap:2"
   * NOT globally unique — the same code may re-fire later after
   * auto_resolve lands.
   */
  code: string;
  category: AlertCategory;
  severity: AlertSeverity;
  title: string;
  description: string;
  explanation: string;
  impact: string;
  suggestedAction: string;
  actionType?: ActionType;
  actionPayload?: ActionPayload;
  relatedEntityType?: string;
  relatedEntityId?: number;
};

export type Detector = () => Promise<DetectorResult[]>;
