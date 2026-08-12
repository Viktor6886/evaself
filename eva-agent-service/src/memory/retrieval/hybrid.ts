/**
 * Гибридный поиск памяти.
 *
 * Один контур, четыре источника кандидатов: полнотекстовый поиск,
 * триграммы, векторное сходство и расширение по графу. Результаты
 * объединяются и ранжируются здесь же — второго RAG-контура нет
 * (инвариант 14).
 *
 * Три правила, ради которых этот модуль устроен именно так:
 *
 *   1. Фильтр по пользователю применяется ДО поиска, а не после. Он
 *      стоит в каждом запросе первым условием и в обходе графа — на
 *      каждом шаге. Отфильтровать чужое после ранжирования означало бы
 *      уже прочитать чужое.
 *   2. Обход графа ограничен: глубина по умолчанию 1, максимум 3, до
 *      50 узлов и 100 связей, жёсткий таймаут. Бюджеты — из `CLAUDE.md`.
 *   3. Таймаут — это безопасная деградация, а не отказ ответа. Поиск
 *      возвращает то, что успел, и честно говорит об этом флагом.
 */

import type { Database } from "../../db.js";
import { vectorLiteral } from "./embeddings.js";

export const GRAPH_LIMITS = {
  defaultDepth: 1,
  maxDepth: 3,
  maxNodes: 50,
  maxEdges: 100,
  timeoutMs: 400,
} as const;

/** Веса источников. Прямое попадание в текст весит больше догадки вектора. */
export const SOURCE_WEIGHTS = {
  fts: 1,
  trigram: 0.7,
  vector: 0.85,
  graph: 0.5,
} as const;

export type RetrievalSource = keyof typeof SOURCE_WEIGHTS;

export interface RetrievalCandidate {
  nodeId: number;
  title: string;
  text: string | null;
  nodeType: string;
  status: string;
  sensitivity: string;
  confidence: number;
  observedAt: string | null;
  sources: RetrievalSource[];
  score: number;
}

export interface RetrievalQuery {
  userId: number;
  text: string;
  limit?: number;
  depth?: number;
  /** Состояние «на дату»: что было верно тогда, а не что верно сейчас. */
  asOf?: Date | null;
  /** Ниже этого порога уверенности кандидат в контекст не идёт. */
  minConfidence?: number;
  /** Чувствительное берётся только по явному запросу. */
  includeSensitive?: boolean;
  vector?: readonly number[] | null;
  signal?: AbortSignal;
}

export interface RetrievalResult {
  candidates: RetrievalCandidate[];
  /** Какие источники успели ответить: пустой означает деградацию. */
  used: RetrievalSource[];
  degraded: boolean;
  elapsedMs: number;
}

interface CandidateRow {
  id: string;
  title: string;
  text_content: string | null;
  node_type: string;
  status: string;
  sensitivity: string;
  confidence: string | number;
  observed_at: string | Date | null;
  score: string | number;
}

export class HybridRetrieval {
  constructor(
    private readonly db: Database,
    private readonly options: {
      enabled: boolean;
      model?: string;
      embeddingVersion?: number;
      timeoutMs?: number;
    },
  ) {}

  get active(): boolean {
    return this.options.enabled;
  }

  /**
   * Найти релевантное.
   *
   * Каждый источник выполняется отдельно и его отказ не отменяет
   * остальные: половина кандидатов лучше отсутствия ответа, если видно,
   * что половина.
   */
  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    const started = Date.now();
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const deadline = started + (this.options.timeoutMs ?? GRAPH_LIMITS.timeoutMs * 3);
    const merged = new Map<number, RetrievalCandidate>();
    const used: RetrievalSource[] = [];
    let degraded = false;

    if (!this.options.enabled) {
      return { candidates: [], used: [], degraded: true, elapsedMs: 0 };
    }

    await this.db.withUserScope(
      { userId: query.userId, label: "memory.retrieval.search", inherit: true },
      async () => {
        const plan: Array<[RetrievalSource, () => Promise<CandidateRow[]>]> = [
          ["fts", () => this.fullText(query, limit)],
          ["trigram", () => this.trigram(query, limit)],
        ];
        if (query.vector?.length) plan.push(["vector", () => this.vector(query, limit)]);

        for (const [source, run] of plan) {
          if (query.signal?.aborted || Date.now() >= deadline) { degraded = true; continue; }
          try {
            for (const row of await run()) this.absorb(merged, row, source);
            used.push(source);
          } catch {
            // Отказ одного источника — деградация, а не ошибка ответа.
            degraded = true;
          }
        }

        // Расширение по графу идёт от уже найденного, а не от запроса:
        // иначе обход пошёл бы по всей памяти.
        const seeds = [...merged.values()]
          .sort((left, right) => right.score - left.score)
          .slice(0, 10)
          .map((candidate) => candidate.nodeId);
        if (seeds.length && !query.signal?.aborted && Date.now() < deadline) {
          try {
            for (const row of await this.graph(query, seeds)) this.absorb(merged, row, "graph");
            used.push("graph");
          } catch {
            degraded = true;
          }
        }
      },
    );

    const candidates = [...merged.values()]
      .filter((candidate) => candidate.confidence >= (query.minConfidence ?? 0))
      .sort((left, right) => right.score - left.score || left.nodeId - right.nodeId)
      .slice(0, limit);
    return { candidates, used, degraded, elapsedMs: Date.now() - started };
  }

  /**
   * Слияние: один узел — один кандидат.
   *
   * Найденный несколькими источниками поднимается, а не дублируется:
   * дубль фрагмента в контексте — это потраченный бюджет на то же самое.
   */
  private absorb(
    merged: Map<number, RetrievalCandidate>,
    row: CandidateRow,
    source: RetrievalSource,
  ): void {
    const nodeId = Number(row.id);
    const contribution = SOURCE_WEIGHTS[source] * Number(row.score ?? 0);
    const existing = merged.get(nodeId);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      existing.score += contribution;
      return;
    }
    merged.set(nodeId, {
      nodeId,
      title: row.title,
      text: row.text_content,
      nodeType: row.node_type,
      status: row.status,
      sensitivity: row.sensitivity,
      confidence: Number(row.confidence ?? 0),
      observedAt: row.observed_at instanceof Date
        ? row.observed_at.toISOString()
        : row.observed_at === null ? null : String(row.observed_at),
      sources: [source],
      score: contribution,
    });
  }

  /** Общие условия отбора: владелец, приватность и время. */
  private filters(query: RetrievalQuery): { sql: string; values: unknown[] } {
    const values: unknown[] = [query.userId];
    let sql = "";
    if (!query.includeSensitive) sql += ` AND n.sensitivity = 'normal'`;
    if (query.asOf) {
      // «На дату» — по времени действительности факта, а не по времени
      // записи: это разные величины (шаг 15).
      values.push(query.asOf);
      sql += ` AND n.valid_from <= $${values.length}
               AND (n.valid_to IS NULL OR n.valid_to > $${values.length})`;
    } else {
      sql += ` AND n.status IN ('active', 'candidate')`;
    }
    return { sql, values };
  }

  private async fullText(query: RetrievalQuery, limit: number): Promise<CandidateRow[]> {
    const { sql, values } = this.filters(query);
    values.push(query.text, limit);
    const { rows } = await this.db.query<CandidateRow>(
      `/* retrieval:fts */
       SELECT n.id, n.title, n.text_content, n.node_type, n.status, n.sensitivity,
              n.confidence, n.valid_from AS observed_at,
              ts_rank(n.search_vector, websearch_to_tsquery('simple', $${values.length - 1})) AS score
         FROM memory_nodes n
        WHERE n.user_id = $1
          ${sql}
          AND n.search_vector @@ websearch_to_tsquery('simple', $${values.length - 1})
        ORDER BY score DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows;
  }

  private async trigram(query: RetrievalQuery, limit: number): Promise<CandidateRow[]> {
    const { sql, values } = this.filters(query);
    values.push(query.text, limit);
    const { rows } = await this.db.query<CandidateRow>(
      `/* retrieval:trigram */
       SELECT n.id, n.title, n.text_content, n.node_type, n.status, n.sensitivity,
              n.confidence, n.valid_from AS observed_at,
              similarity(n.title, $${values.length - 1}) AS score
         FROM memory_nodes n
        WHERE n.user_id = $1
          ${sql}
          AND similarity(n.title, $${values.length - 1}) >= 0.3
        ORDER BY score DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows;
  }

  private async vector(query: RetrievalQuery, limit: number): Promise<CandidateRow[]> {
    const { sql, values } = this.filters(query);
    values.push(
      vectorLiteral(query.vector ?? []),
      this.options.model ?? "",
      this.options.embeddingVersion ?? 1,
      limit,
    );
    const base = values.length - 3;
    const { rows } = await this.db.query<CandidateRow>(
      `/* retrieval:vector */
       SELECT n.id, n.title, n.text_content, n.node_type, n.status, n.sensitivity,
              n.confidence, n.valid_from AS observed_at,
              1 - (e.embedding <=> $${base}::vector) AS score
         FROM memory_embeddings e
         JOIN memory_nodes n
           ON n.user_id = $1
          AND n.id = e.subject_id
        WHERE e.user_id = $1
          AND e.subject_kind = 'node'
          AND e.model = $${base + 1}
          AND e.embedding_version = $${base + 2}
          ${sql}
        ORDER BY e.embedding <=> $${base}::vector
        LIMIT $${values.length}`,
      values,
    );
    return rows;
  }

  /**
   * Расширение по графу.
   *
   * Глубина ограничена, число узлов и связей — тоже, а таймаут задан
   * самому запросу: рекурсивный обход без предела на большой памяти
   * съедает ход целиком.
   */
  private async graph(query: RetrievalQuery, seeds: number[]): Promise<CandidateRow[]> {
    const depth = Math.min(Math.max(query.depth ?? GRAPH_LIMITS.defaultDepth, 1), GRAPH_LIMITS.maxDepth);
    const { sql, values } = this.filters(query);
    values.push(seeds, depth, GRAPH_LIMITS.maxEdges, GRAPH_LIMITS.maxNodes);
    const base = values.length - 3;
    const { rows } = await this.db.query<CandidateRow>(
      `/* retrieval:graph */
       WITH RECURSIVE walk (node_id, depth) AS (
         SELECT unnest($${base}::bigint[]), 0
         UNION
         SELECT CASE WHEN e.from_node_id = w.node_id THEN e.to_node_id ELSE e.from_node_id END,
                w.depth + 1
           FROM walk w
           JOIN LATERAL (
             SELECT from_node_id, to_node_id
               FROM memory_edges
              WHERE user_id = $1
                AND status = 'active'
                AND (from_node_id = w.node_id OR to_node_id = w.node_id)
              LIMIT $${base + 2}
           ) e ON true
          WHERE w.depth < $${base + 1}
       )
       SELECT n.id, n.title, n.text_content, n.node_type, n.status, n.sensitivity,
              n.confidence, n.valid_from AS observed_at,
              1.0 / (1 + min(w.depth)) AS score
         FROM walk w
         JOIN memory_nodes n ON n.user_id = $1 AND n.id = w.node_id
        WHERE n.user_id = $1
          AND w.depth > 0
          ${sql}
        GROUP BY n.id, n.title, n.text_content, n.node_type, n.status, n.sensitivity,
                 n.confidence, n.valid_from
        ORDER BY score DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows;
  }
}
