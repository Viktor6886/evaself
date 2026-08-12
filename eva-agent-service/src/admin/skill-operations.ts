export interface SkillOperationsDatabase {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Durable, privacy-safe aggregates: the query never selects conversation IDs or user text. */
export class SkillOperationsService {
  constructor(private readonly db: SkillOperationsDatabase) {}

  async summary(input: { tenantId?: number; hours?: number } = {}) {
    const hours = Math.max(1, Math.min(24 * 31, Math.trunc(input.hours ?? 24)));
    const tenantId = input.tenantId ?? null;
    const { rows } = await this.db.query(`
      WITH scoped AS (
        SELECT selected, reason_code, sticky, fallback, reranker_called, latency_ms
          FROM skill_routing_events
         WHERE created_at >= now() - make_interval(hours => $1)
           AND ($2::bigint IS NULL OR user_id = $2)
      ), expanded AS (
        SELECT item->>'id' AS id,
               NULLIF(item->>'version_id','')::bigint AS version_id,
               NULLIF(item->>'version','')::integer AS version,
               NULLIF(item->>'score','')::numeric AS score
          FROM scoped CROSS JOIN LATERAL jsonb_array_elements(selected) item
         WHERE jsonb_typeof(item) = 'object'
      )
      SELECT count(*)::integer AS events,
             COALESCE(round(avg(latency_ms)::numeric,2),0) AS latency_avg_ms,
             COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),0) AS latency_p50_ms,
             COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),0) AS latency_p95_ms,
             COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms),0) AS latency_p99_ms,
             count(*) FILTER (WHERE latency_ms < 25)::integer AS latency_lt_25,
             count(*) FILTER (WHERE latency_ms >= 25 AND latency_ms < 100)::integer AS latency_25_99,
             count(*) FILTER (WHERE latency_ms >= 100 AND latency_ms < 500)::integer AS latency_100_499,
             count(*) FILTER (WHERE latency_ms >= 500)::integer AS latency_gte_500,
             count(*) FILTER (WHERE reranker_called)::integer AS reranker_count,
             COALESCE(round(count(*) FILTER (WHERE reranker_called)::numeric / NULLIF(count(*),0),4),0) AS reranker_ratio,
             count(*) FILTER (WHERE sticky)::integer AS sticky_count,
             count(*) FILTER (WHERE fallback)::integer AS fallback_count,
             COALESCE((SELECT jsonb_object_agg(reason_code,n) FROM (SELECT reason_code,count(*)::integer n FROM scoped GROUP BY reason_code ORDER BY reason_code) r),'{}') AS reasons,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'version_id',version_id,'version',version,'selections',n,'avg_score',avg_score) ORDER BY n DESC,id) FROM (SELECT id,version_id,version,count(*)::integer n,round(avg(score)::numeric,4) avg_score FROM expanded GROUP BY id,version_id,version ORDER BY n DESC,id LIMIT 50) s),'[]') AS selected
        FROM scoped`, [hours, tenantId]);
    const row = rows[0] ?? {};
    return {
      window_hours: hours,
      tenant_id: tenantId,
      events: Number(row.events ?? 0),
      latency_ms: { average: Number(row.latency_avg_ms ?? 0), p50: Number(row.latency_p50_ms ?? 0), p95: Number(row.latency_p95_ms ?? 0), p99: Number(row.latency_p99_ms ?? 0), buckets: { lt_25: Number(row.latency_lt_25 ?? 0), from_25_to_99: Number(row.latency_25_99 ?? 0), from_100_to_499: Number(row.latency_100_499 ?? 0), gte_500: Number(row.latency_gte_500 ?? 0) } },
      reranker: { count: Number(row.reranker_count ?? 0), ratio: Number(row.reranker_ratio ?? 0) },
      sticky_count: Number(row.sticky_count ?? 0), fallback_count: Number(row.fallback_count ?? 0),
      reasons: row.reasons ?? {}, selected: row.selected ?? [],
    };
  }
}
