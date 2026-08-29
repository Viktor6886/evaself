import type { Database } from "../db.js";

export interface SubscriptionStatus {
  read_only: true;
  subscription: {
    plan: string;
    status: string;
    source: string | null;
    provider: string | null;
    started_at: string | null;
    ends_at: string | null;
    days_remaining: number | null;
  } | null;
  quotas: Array<{
    metric: string;
    period: string;
    limit: number | null;
    used: number;
    remaining: number | null;
    unlimited: boolean;
  }>;
  free_messages: {
    period: string;
    limit: number | null;
    used: number;
    remaining: number | null;
    unlimited: boolean;
  } | null;
}

/** Read-only projection of the current user's access. */
export class SubscriptionStatusService {
  constructor(private readonly db: Database) {}

  async get(userId: number): Promise<SubscriptionStatus> {
    return await this.db.withUserScope(
      { userId, label: "subscriptions.status" },
      async () => {
        const subscription = await this.db.query<{
          plan: string; status: string; source: string | null; provider: string | null;
          current_period_start: Date | null; current_period_end: Date | null;
        }>(
          `SELECT plan, status, source, provider, current_period_start, current_period_end
             FROM subscriptions
            WHERE user_id = $1
              AND status IN ('trialing', 'active', 'past_due')
              AND (current_period_end IS NULL OR current_period_end > now())
            ORDER BY current_period_end DESC NULLS FIRST, created_at DESC
            LIMIT 1`,
          [userId],
        );
        const quotaRows = await this.db.query<{
          metric: string; period: string; limit_value: string; used: string; remaining: string | null;
        }>(
          `SELECT metric, period, limit_value::text, used::text, remaining::text
             FROM v_quota_status WHERE user_id = $1
            ORDER BY metric, period`,
          [userId],
        );
        const free = await this.db.query<{
          period: string; limit_value: string; used: string; remaining: string | null;
        }>(
          `SELECT q.period, q.limit_value::text,
                  COALESCE(c.used, 0)::text AS used,
                  CASE WHEN q.limit_value < 0 THEN NULL
                       ELSE GREATEST(q.limit_value - COALESCE(c.used, 0), 0)::text
                  END AS remaining
             FROM quotas q
             LEFT JOIN usage_counters c
               ON c.user_id = $1 AND c.metric = q.metric AND c.period = q.period
              AND c.period_start = CASE q.period
                    WHEN 'day' THEN CURRENT_DATE
                    WHEN 'week' THEN date_trunc('week', CURRENT_DATE)::date
                    WHEN 'month' THEN date_trunc('month', CURRENT_DATE)::date
                    ELSE DATE '1970-01-01' END
            WHERE q.plan = 'free' AND q.metric = 'messages'
            ORDER BY CASE q.period WHEN 'day' THEN 1 WHEN 'week' THEN 2 WHEN 'month' THEN 3 ELSE 4 END
            LIMIT 1`,
          [userId],
        );
        const live = subscription.rows[0];
        const freeMessages = free.rows[0];
        return {
          read_only: true,
          subscription: live ? {
            plan: live.plan,
            status: live.status,
            source: live.source,
            provider: live.provider,
            started_at: iso(live.current_period_start),
            ends_at: iso(live.current_period_end),
            days_remaining: live.current_period_end
              ? Math.max(0, Math.ceil((asDate(live.current_period_end).getTime() - Date.now()) / 86_400_000))
              : null,
          } : null,
          quotas: quotaRows.rows.map((row) => quota(row)),
          free_messages: freeMessages ? quota({ metric: "messages", ...freeMessages }) : null,
        };
      },
    );
  }
}

function quota(row: {
  metric: string; period: string; limit_value: string; used: string; remaining: string | null;
}) {
  const limit = Number(row.limit_value);
  return {
    metric: row.metric,
    period: row.period,
    limit: limit < 0 ? null : limit,
    used: Number(row.used),
    remaining: row.remaining === null ? null : Number(row.remaining),
    unlimited: limit < 0,
  };
}

function asDate(value: Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function iso(value: Date | null): string | null {
  if (!value) return null;
  const parsed = asDate(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
