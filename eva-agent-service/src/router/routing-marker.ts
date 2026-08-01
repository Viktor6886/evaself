import { createHmac, timingSafeEqual } from "node:crypto";

export type RoutingPurpose =
  | "chat" | "scheduler" | "maintenance" | "profile"
  | "goal_review" | "partner_analysis" | "research";

export interface RoutingMarkerClaims {
  purpose: RoutingPurpose;
  message_source?: "text" | "voice" | "image" | "document" | "unsupported";
  crisis_level?: "none" | "low" | "medium" | "high" | "critical";
  user_mode?: "economy" | "auto" | "quality";
  internal_operation_type?: string;
  correlation_id?: string;
  related_goals?: number;
  related_tasks?: number;
  related_recent_events?: number;
}

const MARKER = /\[EVA_ROUTING_V1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\]/g;

export function signedRoutingMarker(claims: RoutingMarkerClaims, secret: string): string {
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `[EVA_ROUTING_V1:${payload}.${signature}]`;
}

export function appendRoutingMarker(
  text: string,
  claims: RoutingMarkerClaims,
  secret: string,
): string {
  const marker = signedRoutingMarker(claims, secret);
  return marker ? `${text}\n${marker}` : text;
}

/** Verify the newest valid marker and remove every marker-looking token. */
export function extractRoutingMarker(
  text: string,
  secret: string,
): { text: string; claims: RoutingMarkerClaims | null } {
  let claims: RoutingMarkerClaims | null = null;
  for (const match of text.matchAll(MARKER)) {
    const payload = match[1] ?? "";
    const provided = match[2] ?? "";
    const expected = createHmac("sha256", secret).update(payload).digest("base64url");
    const left = Buffer.from(provided);
    const right = Buffer.from(expected);
    if (!secret || left.length !== right.length || !timingSafeEqual(left, right)) continue;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RoutingMarkerClaims;
      if (validClaims(parsed)) claims = parsed;
    } catch {
      // A malformed token is untrusted input and is only stripped.
    }
  }
  return { text: text.replace(MARKER, "").trimEnd(), claims };
}

function validClaims(value: RoutingMarkerClaims): boolean {
  return Boolean(value && [
    "chat", "scheduler", "maintenance", "profile", "goal_review",
    "partner_analysis", "research",
  ].includes(value.purpose));
}
