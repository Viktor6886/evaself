/**
 * Поиск по загруженным документам.
 *
 * `knowledge_chunks` заполнялся приёмом документов и не читался никем:
 * человек загружал файл в Mini App, а достать из него что-нибудь потом
 * было нечем. Здесь появляется читающий путь — и он же закрывает
 * расхождение с инвариантом 14.
 *
 * Поиск гибридный: полнотекстовый и векторный вместе, слияние рангов по
 * RRF. Ни то, ни другое по отдельности не годится: точное слово из
 * договора вектор находит хуже, чем FTS, а «что там про аренду» — ровно
 * наоборот.
 *
 * Это не второй RAG и не память агента: инструмент просто зарегистрирован,
 * а когда его позвать, решает Letta (инварианты 13 и 17). Найденное —
 * данные, а не инструкции: содержимое чанков уже завёрнуто в конверт
 * недоверенного содержимого при приёме.
 */

import type { Database } from "../db.js";

export interface KnowledgeHit {
  documentId: string;
  documentName: string;
  ordinal: number;
  content: string;
  /** Совместный ранг: чем больше, тем выше. */
  score: number;
  /** Чем нашлось: словами, вектором или обоими способами. */
  matched: "fts" | "vector" | "both";
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** Векторная половина не работала: поиск шёл только словами. */
  degraded: boolean;
}

interface HitRow {
  document_id: string;
  document_name: string;
  ordinal: number;
  content: string;
  score: string | number;
  matched: string;
}

/**
 * Постоянная RRF. Шестьдесят — общепринятое значение: оно сглаживает
 * разницу между списками, где ранги считаются в разных единицах.
 */
const RRF_K = 60;

export class KnowledgeSearch {
  constructor(
    private readonly db: Database,
    /** Вектор запроса. Без него поиск идёт только словами. */
    private readonly embed?: (text: string, signal?: AbortSignal) => Promise<number[]>,
  ) {}

  async search(
    userId: number,
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<KnowledgeSearchResult> {
    const clean = query.trim().slice(0, 1_000);
    if (!clean) return { hits: [], degraded: false };
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);

    // Вектор считается до запроса и не роняет поиск: провайдер
    // эмбеддингов может лежать, а найти по словам всё ещё можно.
    let vector: string | null = null;
    if (this.embed) {
      try {
        vector = `[${(await this.embed(clean, options.signal)).join(",")}]`;
      } catch {
        vector = null;
      }
    }

    const { rows } = await this.db.withUserScope(
      { userId, label: "knowledge.search", inherit: true },
      async () => await this.db.query<HitRow>(
        `WITH ask AS (
           SELECT websearch_to_tsquery('simple', $2) AS tsq
         ),
         visible AS (
           SELECT c.id, c.document_id, c.ordinal, c.content, c.embedding
             FROM knowledge_chunks c
            WHERE c.user_id = $1 OR c.product_verified
         ),
         fts AS (
           SELECT v.id,
                  row_number() OVER (
                    ORDER BY ts_rank(to_tsvector('simple', v.content), ask.tsq) DESC, v.id
                  ) AS position
             FROM visible v, ask
            WHERE to_tsvector('simple', v.content) @@ ask.tsq
            LIMIT $3
         ),
         vec AS (
           SELECT v.id,
                  row_number() OVER (ORDER BY v.embedding <=> $4::vector, v.id) AS position
             FROM visible v
            WHERE $4::vector IS NOT NULL
            ORDER BY v.embedding <=> $4::vector
            LIMIT $3
         ),
         fused AS (
           SELECT COALESCE(fts.id, vec.id) AS id,
                  COALESCE(1.0 / ($5 + fts.position), 0)
                    + COALESCE(1.0 / ($5 + vec.position), 0) AS score,
                  CASE
                    WHEN fts.id IS NOT NULL AND vec.id IS NOT NULL THEN 'both'
                    WHEN fts.id IS NOT NULL THEN 'fts'
                    ELSE 'vector'
                  END AS matched
             FROM fts FULL OUTER JOIN vec ON vec.id = fts.id
         )
         SELECT c.document_id,
                d.name AS document_name,
                c.ordinal,
                c.content,
                fused.score,
                fused.matched
           FROM fused
           JOIN knowledge_chunks c ON c.id = fused.id
           -- tenant: by user_id — документ подтягивается к уже отобранному
           -- фрагменту этого человека или к общему продуктовому
           JOIN knowledge_documents d ON d.id = c.document_id
          WHERE c.user_id = $1 OR c.product_verified
          ORDER BY fused.score DESC, c.document_id, c.ordinal
          LIMIT $3`,
        [userId, clean, limit, vector, RRF_K],
      ),
    );

    return {
      hits: rows.map((row) => ({
        documentId: String(row.document_id),
        documentName: row.document_name,
        ordinal: Number(row.ordinal),
        content: row.content,
        score: Number(row.score),
        matched: row.matched === "both" || row.matched === "vector" ? row.matched : "fts",
      })),
      degraded: vector === null,
    };
  }
}
