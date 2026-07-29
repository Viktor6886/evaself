import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

interface ContextNode {
  id: number;
  node_type: string;
  title: string;
  text_content: string | null;
  confidence: number;
  updated_at: string;
  score: number;
}

interface ContextEdge {
  from_node_id: number;
  relation_type: string;
  to_node_id: number;
  weight: number;
  confidence: number;
}

interface GraphQueryRow {
  nodes: ContextNode[];
  edges: ContextEdge[];
}

export interface GraphContextResult {
  relevantMemory: string[];
  elapsedMs: number;
  used: boolean;
  timedOut: boolean;
}

export class GraphContextService {
  constructor(
    private readonly db: Database,
    private readonly options: {
      enabled: boolean;
      timeoutMs?: number;
      maxNodes?: number;
      maxEdges?: number;
    },
    private readonly logger?: Logger,
  ) {}

  async findRelevant(userId: number, message: string): Promise<GraphContextResult> {
    const started = performance.now();
    if (!this.options.enabled || !shouldUseGraphContext(message)) {
      return { relevantMemory: [], elapsedMs: 0, used: false, timedOut: false };
    }
    const timeoutMs = bounded(this.options.timeoutMs ?? 75, 10, 2_000);
    const maxNodes = bounded(this.options.maxNodes ?? 12, 5, 12);
    const maxEdges = bounded(this.options.maxEdges ?? 18, 1, 18);
    const depth = needsDeepReview(message) ? 2 : 1;
    const preferredTypes = graphTypesFor(message);

    try {
      const row = await this.db.transaction(async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);
        const { rows } = await client.query<GraphQueryRow>(
          `WITH RECURSIVE
           search AS (
             SELECT websearch_to_tsquery('simple', $2) AS query
           ),
           seed AS (
             SELECT
               n.id,
               (
                 ts_rank(
                   to_tsvector('simple', COALESCE(n.title, '') || ' ' || COALESCE(n.text_content, '')),
                   search.query
                 ) * 4
                 + similarity(COALESCE(n.title, '') || ' ' || COALESCE(n.text_content, ''), $2)
                 + n.confidence::double precision
                 + GREATEST(
                     0,
                     1 - EXTRACT(EPOCH FROM (now() - n.updated_at)) / 31536000
                   ) * 0.25
               ) AS score
             FROM memory_nodes n
             CROSS JOIN search
             WHERE n.user_id = $1
               AND n.status = 'active'
               AND n.sensitivity = 'normal'
               AND (
                 search.query @@ to_tsvector(
                   'simple',
                   COALESCE(n.title, '') || ' ' || COALESCE(n.text_content, '')
                 )
                 OR similarity(
                   COALESCE(n.title, '') || ' ' || COALESCE(n.text_content, ''),
                   $2
                 ) > 0.08
                 OR n.node_type = ANY($7::text[])
               )
             ORDER BY score DESC, n.updated_at DESC
             LIMIT $3
           ),
           walk(node_id, depth, path, score) AS (
             SELECT id, 0, ARRAY[id]::bigint[], score FROM seed
             UNION ALL
             SELECT
               adjacent.node_id,
               walk.depth + 1,
               walk.path || adjacent.node_id,
               walk.score * LEAST(e.weight::double precision, 2) *
                 e.confidence::double precision * 0.5
             FROM walk
             JOIN memory_edges e
               ON e.user_id = $1
              AND e.status = 'active'
              AND (e.from_node_id = walk.node_id OR e.to_node_id = walk.node_id)
             CROSS JOIN LATERAL (
               SELECT CASE
                 WHEN e.from_node_id = walk.node_id THEN e.to_node_id
                 ELSE e.from_node_id
               END AS node_id
             ) adjacent
             WHERE walk.depth < $4
               AND NOT adjacent.node_id = ANY(walk.path)
           ),
           ranked AS (
             SELECT node_id, MAX(score) AS score
             FROM walk
             GROUP BY node_id
             ORDER BY score DESC
             LIMIT $5
           ),
           selected_nodes AS (
             SELECT
               n.id,
               n.node_type,
               n.title,
               n.text_content,
               n.confidence::double precision AS confidence,
               n.updated_at,
               ranked.score
             FROM ranked
             JOIN memory_nodes n
               ON n.id = ranked.node_id
              AND n.user_id = $1
              AND n.status = 'active'
              AND n.sensitivity = 'normal'
             ORDER BY ranked.score DESC, n.updated_at DESC
           ),
           selected_edges AS (
             SELECT
               e.from_node_id,
               e.relation_type,
               e.to_node_id,
               e.weight::double precision AS weight,
               e.confidence::double precision AS confidence
             FROM memory_edges e
             JOIN ranked from_ranked ON from_ranked.node_id = e.from_node_id
             JOIN ranked to_ranked ON to_ranked.node_id = e.to_node_id
             WHERE e.user_id = $1 AND e.status = 'active'
             ORDER BY
               (from_ranked.score + to_ranked.score) * e.weight * e.confidence DESC,
               e.id
             LIMIT $6
           )
           SELECT
             COALESCE((SELECT jsonb_agg(to_jsonb(n)) FROM selected_nodes n), '[]'::jsonb) AS nodes,
             COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM selected_edges e), '[]'::jsonb) AS edges`,
          [userId, message.slice(0, 2_000), maxNodes, depth, maxNodes, maxEdges, preferredTypes],
        );
        return rows[0] ?? { nodes: [], edges: [] };
      });
      return {
        relevantMemory: summarizeGraph(row.nodes, row.edges, maxNodes),
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        used: true,
        timedOut: false,
      };
    } catch (error) {
      const timedOut =
        (error as { code?: string }).code === "57014" ||
        /statement timeout|canceling statement/i.test(
          error instanceof Error ? error.message : String(error),
        );
      this.logger?.warn(
        timedOut
          ? "Графовый контекст не уложился в лимит и пропущен"
          : "Графовый контекст недоступен и пропущен",
        {
          userId,
          timeoutMs,
          message: error instanceof Error ? error.message : String(error),
        },
      );
      return {
        relevantMemory: [],
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
        used: true,
        timedOut,
      };
    }
  }
}

export function shouldUseGraphContext(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLocaleLowerCase("ru");
  if (!normalized || normalized.startsWith("/")) return false;
  if (/^(привет|здравствуй|доброе утро|добрый день|добрый вечер|hello|hi|hey)[!. ]*$/.test(normalized)) {
    return false;
  }
  if (/^(да|нет|ок|okay|спасибо|thanks|понял[а]?)[!. ]*$/.test(normalized)) return false;
  if (
    /^(напомни|создай задачу|запиши заметку|сколько времени|какая погода)/.test(normalized)
  ) {
    return false;
  }
  return [
    /(цел[ьи]|результат|план|шаг|прогресс|достичь|goal|progress)/,
    /(посоветуй|рекоменд|что мне помогает|what helps|recommend)/,
    /(снова|опять|повторя|откладыва|прокрастин|again|procrastinat)/,
    /(вспомни|прошлое решение|мы решили|remember|last decision)/,
    /(ревизи|обзор недели|итоги недели|weekly review)/,
    /(мама|папа|партн[её]р|муж|жена|друг|коллег|mother|father|partner)/,
  ].some((pattern) => pattern.test(normalized));
}

function needsDeepReview(message: string): boolean {
  return /(ревизи|обзор недели|итоги недели|почему я снова|почему опять|weekly review|why.*again)/iu
    .test(message);
}

function graphTypesFor(message: string): string[] {
  const normalized = message.toLocaleLowerCase("ru");
  const result = new Set<string>();
  if (/(цел|результат|план|шаг|прогресс|goal|progress)/u.test(normalized)) {
    ["goal", "goal_result", "task", "artifact", "review"].forEach((type) => result.add(type));
  }
  if (/(помога|рекоменд|посовет|откладыва|прокрастин|helps|recommend)/u.test(normalized)) {
    ["strategy", "obstacle", "value", "anti_goal"].forEach((type) => result.add(type));
  }
  if (/(вспомни|решение|remember|decision)/u.test(normalized)) {
    ["decision", "event", "review"].forEach((type) => result.add(type));
  }
  if (/(мама|папа|партн[её]р|муж|жена|друг|коллег|mother|father|partner)/u.test(normalized)) {
    ["person", "relationship", "event"].forEach((type) => result.add(type));
  }
  return [...result].slice(0, 8);
}

function summarizeGraph(
  nodes: ContextNode[],
  edges: ContextEdge[],
  maxNodes: number,
): string[] {
  const nodesById = new Map(nodes.map((node) => [Number(node.id), node]));
  const links = new Map<number, string[]>();
  for (const edge of edges.slice(0, 18)) {
    const from = nodesById.get(Number(edge.from_node_id));
    const to = nodesById.get(Number(edge.to_node_id));
    if (!from || !to) continue;
    const list = links.get(Number(from.id)) ?? [];
    if (list.length < 3) list.push(`${relationLabel(edge.relation_type)} «${safe(to.title, 120)}»`);
    links.set(Number(from.id), list);
  }
  return nodes.slice(0, maxNodes).map((node) => {
    const details = safe(node.text_content ?? "", 240);
    const relations = links.get(Number(node.id)) ?? [];
    return [
      `${nodeLabel(node.node_type)}: ${safe(node.title, 160)}`,
      details && details !== node.title ? details : "",
      relations.length > 0 ? relations.join("; ") : "",
    ].filter(Boolean).join(" — ");
  });
}

function nodeLabel(type: string): string {
  return {
    goal: "Цель",
    goal_result: "Результат",
    task: "Задача",
    interest: "Интерес",
    value: "Ценность",
    anti_goal: "Ограничение",
    person: "Человек",
    relationship: "Отношение",
    event: "Событие",
    obstacle: "Препятствие",
    strategy: "Рабочая стратегия",
    artifact: "Артефакт",
    review: "Обзор",
    decision: "Решение",
    profile_fact: "Факт профиля",
  }[type] ?? "Факт";
}

function relationLabel(type: string): string {
  return {
    aligned_with: "связано с ценностью",
    constrained_by: "ограничено",
    part_of: "часть",
    depends_on: "зависит от",
    advances: "продвигает",
    blocks: "мешает",
    helps_with: "помогает при",
    effective_for: "работает для",
    produced_by: "создано в",
    evaluates: "оценивает",
    involves: "включает",
    supports: "подтверждает",
    belongs_to: "относится к",
    uses: "использует",
  }[type] ?? type;
}

function safe(value: string, max: number): string {
  return value.replace(/[<>{}]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
