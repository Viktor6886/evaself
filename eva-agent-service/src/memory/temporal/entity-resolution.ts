/**
 * Разрешение сущностей.
 *
 * Задача — понять, о ком идёт речь, и НЕ склеить разных людей. Ошибка
 * здесь дороже пропуска: разъединить ошибочно объединённых сложнее, чем
 * объединить позже, а память при этом успевает выдать человеку факты о
 * чужой жизни.
 *
 * Поэтому автоматическое объединение возможно только при высокой
 * уверенности и только при выполненных запретах:
 *
 *   • два человека с одинаковым именем автоматически не объединяются;
 *   • человек и организация не объединяются никогда;
 *   • прежняя и новая работа — разные сущности, а не одна изменившаяся.
 *
 * Каждое автоматическое объединение записывается в `memory_entity_merges`
 * со снимком прежнего состояния — иначе откат невозможен.
 *
 * Векторов здесь нет намеренно: embeddings — шаг 18.
 */

import type { GraphNodeType, GraphQueryable } from "../graph-repository.js";
import type { MemoryActor } from "./versions.js";

export type ResolutionDecision = "matched" | "candidate" | "separate";

export interface EntityCandidate {
  nodeId: number;
  title: string;
  nodeType: GraphNodeType;
  score: number;
  reason: string;
  /** Структурированное содержимое узла: по нему идёт контекстное сравнение. */
  context: Record<string, unknown>;
}

/**
 * Нормализация имени в SQL.
 *
 * Обязана давать ТОТ ЖЕ результат, что `normalizeName()` в этом файле:
 * запрос сравнивает вычисленное базой значение с нормализованным
 * параметром, и расхождение в одном символе превращает точное совпадение
 * в промах. Поэтому выражение живёт здесь, рядом со своей парой, а не
 * переписывается в каждом запросе.
 */
export function normalizedNameSql(column: string): string {
  return `btrim(regexp_replace(translate(lower(${column}), 'ё', 'е'), '[^[:alnum:]]+', ' ', 'g'))`;
}

export interface ResolutionResult {
  decision: ResolutionDecision;
  match: EntityCandidate | null;
  candidates: EntityCandidate[];
  /** Что именно помешало объединить. Пустая строка — не мешало ничего. */
  blockedBy: string;
}

export interface ResolveInput {
  userId: number;
  nodeType: GraphNodeType;
  name: string;
  /** Контекстные признаки: роль, организация, город, дата рождения. */
  context?: Record<string, string | null | undefined>;
  /** Исключить из кандидатов — например, сам разрешаемый узел. */
  excludeNodeId?: number;
}

/** Порог автоматического объединения. Ниже — только кандидат. */
export const AUTO_MERGE_SCORE = 0.9;
/** Порог, ниже которого кандидат даже не предлагается. */
export const CANDIDATE_SCORE = 0.6;

/**
 * Типы, которые нельзя объединять между собой ни при каком совпадении
 * имени. «Норильский никель» и человек по фамилии Никель — разные вещи,
 * сколько бы ни совпало символов.
 */
const NEVER_MERGE_ACROSS: ReadonlySet<GraphNodeType> = new Set<GraphNodeType>([
  "person",
  "artifact",
  "goal",
  "task",
]);

/**
 * Контекстные признаки, различие которых означает РАЗНЫЕ сущности, а не
 * изменившуюся одну. Организация здесь ключевая: смена работы обязана
 * порождать новую сущность места работы, иначе история «где он работал»
 * схлопнется в одну запись.
 */
const DISCRIMINATING_KEYS = ["organization", "birth_date", "external_id"] as const;

export class EntityResolver {
  /**
   * Найти сущность по имени.
   *
   * Порядок: точное совпадение нормализованного имени → совпадение по
   * синониму → полнотекстовый поиск среди того же типа. Тип фильтруется
   * всегда: поиск «по всему графу» неизбежно сводит человека с задачей,
   * названной его именем.
   */
  async resolve(client: GraphQueryable, input: ResolveInput): Promise<ResolutionResult> {
    const normalized = normalizeName(input.name);
    if (!normalized) {
      return { decision: "separate", match: null, candidates: [], blockedBy: "empty_name" };
    }

    const candidates = await this.candidates(client, input, normalized);
    if (candidates.length === 0) {
      return { decision: "separate", match: null, candidates: [], blockedBy: "" };
    }

    const best = candidates[0]!;
    const blocked = this.blockedReason(client, input, best);
    if (blocked) {
      // Запрет не понижает оценку, а снимает автоматизм: сущность
      // остаётся отдельной, а совпадение показывается как кандидат.
      return {
        decision: candidates.length > 0 ? "candidate" : "separate",
        match: null,
        candidates,
        blockedBy: blocked,
      };
    }
    if (best.score >= AUTO_MERGE_SCORE) {
      return { decision: "matched", match: best, candidates, blockedBy: "" };
    }
    if (best.score >= CANDIDATE_SCORE) {
      return { decision: "candidate", match: null, candidates, blockedBy: "" };
    }
    return { decision: "separate", match: null, candidates: [], blockedBy: "" };
  }

  private async candidates(
    client: GraphQueryable,
    input: ResolveInput,
    normalized: string,
  ): Promise<EntityCandidate[]> {
    const exclude = input.excludeNodeId ?? 0;
    const found = new Map<number, EntityCandidate>();

    // 1. Точное совпадение нормализованного имени.
    const exact = await client.query<CandidateRow>(
      `SELECT n.id, n.title, n.node_type, n.content_json
         FROM memory_nodes n
        WHERE n.user_id = $1 AND n.node_type = $2 AND n.id <> $3
          AND n.status = ANY(ARRAY['active', 'candidate'])
          AND ${normalizedNameSql("n.title")} = $4`,
      [input.userId, input.nodeType, exclude, normalized],
    );
    for (const row of exact.rows) {
      found.set(Number(row.id), toCandidate(row, 0.95, "exact_name"));
    }

    // 2. Синонимы: «Саня» и «Александр» — один человек, если так сказано.
    const alias = await client.query<CandidateRow>(
      `SELECT n.id, n.title, n.node_type, n.content_json
         FROM memory_entity_aliases a
         JOIN memory_nodes n ON n.user_id = a.user_id AND n.id = a.node_id
        WHERE a.user_id = $1 AND n.user_id = $1
          AND a.node_type = $2 AND n.id <> $3
          AND a.normalized_alias = $4`,
      [input.userId, input.nodeType, exclude, normalized],
    );
    for (const row of alias.rows) {
      const existing = found.get(Number(row.id));
      if (!existing) found.set(Number(row.id), toCandidate(row, 0.92, "alias"));
    }

    // 3. Полнотекстовый поиск — только внутри типа и только как источник
    //    кандидатов: автоматическое объединение по нему не делается.
    if (found.size === 0) {
      const fts = await client.query<CandidateRow>(
        `SELECT n.id, n.title, n.node_type, n.content_json
           FROM memory_nodes n
          WHERE n.user_id = $1 AND n.node_type = $2 AND n.id <> $3
            AND n.status = ANY(ARRAY['active', 'candidate'])
            AND to_tsvector('simple', COALESCE(n.title, '') || ' ' || COALESCE(n.text_content, ''))
                @@ websearch_to_tsquery('simple', $4)
          LIMIT 10`,
        [input.userId, input.nodeType, exclude, normalized],
      );
      for (const row of fts.rows) {
        found.set(Number(row.id), toCandidate(row, 0.65, "fulltext"));
      }
    }

    const scored = [...found.values()].map((candidate) => ({
      ...candidate,
      score: this.contextScore(candidate, input),
    }));
    return scored
      .filter((candidate) => candidate.score >= CANDIDATE_SCORE)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  }

  /**
   * Контекстное сравнение.
   *
   * Совпавший различающий признак поднимает оценку, РАЗЛИЧАЮЩИЙСЯ —
   * обрушивает её ниже порога кандидата. Отсутствующий не делает ничего:
   * незнание — не довод ни за, ни против.
   */
  private contextScore(candidate: EntityCandidate, input: ResolveInput): number {
    const context = input.context ?? {};
    const stored = candidate.context;
    let score = candidate.score;
    for (const key of DISCRIMINATING_KEYS) {
      const left = normalizeName(String(context[key] ?? ""));
      const right = normalizeName(String(stored[key] ?? ""));
      if (!left || !right) continue;
      if (left === right) score = Math.min(1, score + 0.05);
      else return 0.3;
    }
    return score;
  }

  /**
   * Причина, по которой автоматическое объединение запрещено.
   *
   * Тёзки: одинаковое имя без единого совпавшего различающего признака —
   * это ровно тот случай, ради которого требование написано.
   */
  private blockedReason(
    _client: GraphQueryable,
    input: ResolveInput,
    candidate: EntityCandidate,
  ): string {
    if (candidate.nodeType !== input.nodeType) return "type_mismatch";
    if (NEVER_MERGE_ACROSS.has(input.nodeType)) {
      const context = input.context ?? {};
      const stored = candidate.context;
      const shared = DISCRIMINATING_KEYS.some((key) => {
        const left = normalizeName(String(context[key] ?? ""));
        const right = normalizeName(String(stored[key] ?? ""));
        return Boolean(left) && left === right;
      });
      if (!shared) return "namesake_without_shared_context";
    }
    return "";
  }

  /**
   * Объединить сущности.
   *
   * Объединение НЕ удаляет исходный узел: он получает `entity_id`
   * целевого и статус `superseded`. Так факты остаются на месте, а откат
   * сводится к возврату двух полей — по снимку, записанному здесь же.
   */
  async merge(
    client: GraphQueryable,
    input: {
      userId: number;
      sourceNodeId: number;
      targetNodeId: number;
      score: number;
      reason: string;
      actorType: MemoryActor;
    },
  ): Promise<number> {
    if (input.sourceNodeId === input.targetNodeId) {
      throw new Error("Объединение узла с самим собой");
    }
    const { rows: before } = await client.query<{ entity_id: string | null; status: string }>(
      `SELECT entity_id, status FROM memory_nodes WHERE user_id = $1 AND id = $2`,
      [input.userId, input.sourceNodeId],
    );
    if (!before[0]) throw new Error("Исходный узел объединения не найден");

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO memory_entity_merges (
         user_id, source_node_id, target_node_id, decision, score, reason,
         actor_type, snapshot
       ) VALUES ($1, $2, $3, 'merged', $4, $5, $6, $7::jsonb)
       RETURNING id`,
      [
        input.userId,
        input.sourceNodeId,
        input.targetNodeId,
        clamp01(input.score),
        input.reason.slice(0, 400),
        input.actorType,
        JSON.stringify({ entity_id: before[0].entity_id, status: before[0].status }),
      ],
    );

    await client.query(
      `UPDATE memory_nodes SET entity_id = $3, status = 'superseded'
        WHERE user_id = $1 AND id = $2`,
      [input.userId, input.sourceNodeId, input.targetNodeId],
    );
    return Number(rows[0]!.id);
  }

  /** Откат объединения по снимку. Повторный откат ничего не делает. */
  async rollbackMerge(
    client: GraphQueryable,
    userId: number,
    mergeId: number,
  ): Promise<boolean> {
    const { rows } = await client.query<{
      source_node_id: string;
      snapshot: { entity_id?: string | number | null; status?: string };
    }>(
      `UPDATE memory_entity_merges
          SET rolled_back_at = now()
        WHERE user_id = $1 AND id = $2 AND rolled_back_at IS NULL
        RETURNING source_node_id, snapshot`,
      [userId, mergeId],
    );
    const row = rows[0];
    if (!row) return false;
    await client.query(
      `UPDATE memory_nodes SET entity_id = $3, status = $4
        WHERE user_id = $1 AND id = $2`,
      [
        userId,
        Number(row.source_node_id),
        row.snapshot?.entity_id ?? null,
        row.snapshot?.status ?? "active",
      ],
    );
    return true;
  }

  /** Записать синоним. Повтор — не ошибка, а отсутствие изменения. */
  async addAlias(
    client: GraphQueryable,
    input: {
      userId: number;
      nodeId: number;
      nodeType: GraphNodeType;
      alias: string;
      aliasKind?: "primary" | "synonym" | "nickname" | "former";
    },
  ): Promise<boolean> {
    const normalized = normalizeName(input.alias);
    if (!normalized) return false;
    const result = await client.query(
      `INSERT INTO memory_entity_aliases (
         user_id, node_id, node_type, alias, normalized_alias, alias_kind
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, node_id, normalized_alias) DO NOTHING`,
      [
        input.userId,
        input.nodeId,
        input.nodeType,
        input.alias.trim().slice(0, 300),
        normalized,
        input.aliasKind ?? "synonym",
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

interface CandidateRow {
  id: string;
  title: string;
  node_type: GraphNodeType;
  content_json: Record<string, unknown> | null;
}

function toCandidate(row: CandidateRow, score: number, reason: string): EntityCandidate {
  return {
    nodeId: Number(row.id),
    title: row.title,
    nodeType: row.node_type,
    score,
    reason,
    context: row.content_json ?? {},
  };
}

/**
 * Нормализация имени: регистр, пробелы, дефисы и «ё». Транслитерация не
 * делается — она порождает ложные совпадения между разными языками.
 */
export function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 300);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}
