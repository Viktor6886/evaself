/**
 * Семантическая дедупликация без векторов.
 *
 * Требование 8 шага: перед созданием узла — точный поиск, синонимы,
 * полнотекстовый поиск; перед созданием связи — совпадение источника,
 * типа и цели с ПЕРЕСЕЧЕНИЕМ периода действительности. При совпадении
 * добавляется доказательство, а не дубликат.
 *
 * Пересечение периодов — не формальность. «Работает в А» с 2020 по 2023
 * и «работает в А» с 2025 — это два разных периода одной жизни, и
 * склеивать их в одну связь нельзя: история занятости потеряется.
 *
 * Embeddings здесь отсутствуют намеренно — они относятся к шагу 18.
 */

import type { GraphNodeType, GraphQueryable, GraphRelationType } from "../graph-repository.js";
import { normalizeName, normalizedNameSql } from "./entity-resolution.js";

export interface NodeDuplicate {
  nodeId: number;
  title: string;
  matchedBy: "canonical" | "exact_title" | "alias" | "fulltext";
}

export interface EdgeDuplicate {
  edgeId: number;
  validFrom: Date | null;
  validTo: Date | null;
}

export class MemoryDeduplicator {
  /**
   * Найти существующий узел, к которому нужно добавить доказательство
   * вместо создания нового. Порядок проверок — от самой надёжной к самой
   * слабой; полнотекстовый поиск включается, только когда точные не дали
   * ничего.
   */
  async findNodeDuplicate(
    client: GraphQueryable,
    input: {
      userId: number;
      nodeType: GraphNodeType;
      canonicalKey: string;
      title: string;
    },
  ): Promise<NodeDuplicate | null> {
    const canonical = await client.query<{ id: string; title: string }>(
      `SELECT id, title FROM memory_nodes
        WHERE user_id = $1 AND node_type = $2 AND canonical_key = $3`,
      [input.userId, input.nodeType, input.canonicalKey],
    );
    if (canonical.rows[0]) {
      return {
        nodeId: Number(canonical.rows[0].id),
        title: canonical.rows[0].title,
        matchedBy: "canonical",
      };
    }

    const normalized = normalizeName(input.title);
    if (!normalized) return null;

    const exact = await client.query<{ id: string; title: string }>(
      `SELECT id, title FROM memory_nodes
        WHERE user_id = $1 AND node_type = $2
          AND status = ANY(ARRAY['active', 'candidate'])
          AND ${normalizedNameSql("title")} = $3
        LIMIT 1`,
      [input.userId, input.nodeType, normalized],
    );
    if (exact.rows[0]) {
      return {
        nodeId: Number(exact.rows[0].id),
        title: exact.rows[0].title,
        matchedBy: "exact_title",
      };
    }

    const alias = await client.query<{ id: string; title: string }>(
      `SELECT n.id, n.title
         FROM memory_entity_aliases a
         JOIN memory_nodes n ON n.user_id = a.user_id AND n.id = a.node_id
        WHERE a.user_id = $1 AND n.user_id = $1
          AND a.node_type = $2 AND a.normalized_alias = $3
        LIMIT 1`,
      [input.userId, input.nodeType, normalized],
    );
    if (alias.rows[0]) {
      return {
        nodeId: Number(alias.rows[0].id),
        title: alias.rows[0].title,
        matchedBy: "alias",
      };
    }

    const fts = await client.query<{ id: string; title: string }>(
      `SELECT id, title FROM memory_nodes
        WHERE user_id = $1 AND node_type = $2
          AND status = ANY(ARRAY['active', 'candidate'])
          AND to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(text_content, ''))
              @@ websearch_to_tsquery('simple', $3)
        LIMIT 1`,
      [input.userId, input.nodeType, normalized],
    );
    if (fts.rows[0]) {
      return {
        nodeId: Number(fts.rows[0].id),
        title: fts.rows[0].title,
        matchedBy: "fulltext",
      };
    }
    return null;
  }

  /**
   * Найти связь того же смысла с пересекающимся периодом.
   *
   * Пересечение считается по полуинтервалу [valid_from, valid_to):
   * связь, закончившаяся ровно тогда, когда началась новая, дубликатом
   * не считается. Открытый конец (`valid_to IS NULL`) пересекается со
   * всем, что начинается после его начала.
   */
  async findEdgeDuplicate(
    client: GraphQueryable,
    input: {
      userId: number;
      fromNodeId: number;
      relationType: GraphRelationType;
      toNodeId: number;
      validFrom: Date;
      validTo?: Date | null;
    },
  ): Promise<EdgeDuplicate | null> {
    const { rows } = await client.query<{
      id: string;
      valid_from: Date | null;
      valid_to: Date | null;
    }>(
      `SELECT id, valid_from, valid_to
         FROM memory_edges
        WHERE user_id = $1
          AND from_node_id = $2 AND relation_type = $3 AND to_node_id = $4
          AND status = ANY(ARRAY['active', 'candidate'])
          AND (valid_from IS NULL OR $6::timestamptz IS NULL OR valid_from < $6)
          AND (valid_to IS NULL OR valid_to > $5)
        ORDER BY id ASC
        LIMIT 1`,
      [
        input.userId,
        input.fromNodeId,
        input.relationType,
        input.toNodeId,
        input.validFrom,
        input.validTo ?? null,
      ],
    );
    const row = rows[0];
    return row
      ? { edgeId: Number(row.id), validFrom: row.valid_from, validTo: row.valid_to }
      : null;
  }
}

/**
 * Пересекаются ли два периода действительности.
 *
 * Вынесено отдельно от SQL, чтобы правило можно было проверить тестом
 * без базы: граничный случай «конец одного равен началу другого» —
 * именно тот, на котором ошибаются.
 */
export function periodsOverlap(
  left: { from: Date; to: Date | null },
  right: { from: Date; to: Date | null },
): boolean {
  const leftEnd = left.to?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightEnd = right.to?.getTime() ?? Number.POSITIVE_INFINITY;
  return left.from.getTime() < rightEnd && right.from.getTime() < leftEnd;
}
