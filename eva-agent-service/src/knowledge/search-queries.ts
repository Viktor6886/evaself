/**
 * SQL поиска по базе знаний (docs/knowledge-base.md, «Поиск (K4)»).
 *
 * Видимость во всех запросах одна: свои фрагменты, если личная база
 * включена в поиск, и общие — если включена общая и коллекция документа
 * не выключена. Документ присоединяется с тем же условием владельца, что
 * и фрагмент: граница арендатора (`src/tenancy/`) проверяет каждую
 * пользовательскую таблицу запроса, и документ без условия по `user_id`
 * отклонялся бы на каждом поиске.
 *
 * Параметры у всех запросов начинаются одинаково: $1 — человек, $2 —
 * личная база в поиске, $3 — общая.
 */

import type { Database } from "../db.js";

export interface SearchScope {
  userId: number;
  privateEnabled: boolean;
  globalEnabled: boolean;
}

/** Порог сходства триграмм для `<%`: 0,5 ловит одну опечатку в слове из шести букв. */
export const TRIGRAM_THRESHOLD = 0.5;

const scopeValues = (scope: SearchScope): unknown[] => [scope.userId, scope.privateEnabled, scope.globalEnabled];

interface ScoredRow {
  signal?: string;
  id: string;
  score: string | number;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  document_name: string;
  ordinal: number;
  content: string;
  content_hash: string;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  subsection: string | null;
  heading: string | null;
  global: boolean;
}

export interface NeighborRow {
  document_id: string;
  ordinal: number;
  content: string;
}

/**
 * Лексическая половина: русская морфология (индекс 091
 * `to_tsvector('russian', content)`, фразы в кавычках —
 * `websearch_to_tsquery`) и, если в запросе есть обозначения, номера,
 * фамилии или он короткий, — триграммы (индексы 091 `gin_trgm_ops` по
 * тексту фрагмента и по названию документа). Порог триграмм задаётся на
 * транзакцию: оператор `<%` читает его из настройки сеанса, а индекс
 * работает только с оператором.
 *
 * Ранг каждого списка считается здесь, по оценке: порядок строк
 * `UNION ALL` стандарт не гарантирует.
 */
export async function lexicalCandidates(
  db: Database,
  scope: SearchScope,
  query: string,
  terms: readonly string[],
  limit: number,
): Promise<{ fts: ScoredRow[]; trgm: ScoredRow[] }> {
  const sql = terms.length
    ? `WITH ${ASK_CTE},
       ${FTS_CTE},
       ${trigramCte(terms.length)}
       SELECT 'fts' AS signal, id::text AS id, score FROM fts
       UNION ALL
       SELECT 'trgm' AS signal, id::text AS id, score FROM trgm`
    : `WITH ${ASK_CTE},
       ${FTS_CTE}
       SELECT 'fts' AS signal, id::text AS id, score FROM fts`;
  const values = [...scopeValues(scope), query, limit, ...terms];
  const { rows } = await db.withUserScope(
    { userId: scope.userId, label: "knowledge.search.lexical", inherit: true },
    async () => terms.length
      ? await db.transaction(async (client) => {
        await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${TRIGRAM_THRESHOLD}`);
        return await client.query<ScoredRow>(sql, values);
      })
      : await db.query<ScoredRow>(sql, values),
  );
  const ranked = (signal: string): ScoredRow[] => rows
    .filter((row) => row.signal === signal)
    .sort((a, b) => Number(b.score) - Number(a.score) || compareIds(a.id, b.id));
  return { fts: ranked("fts"), trgm: ranked("trgm") };
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Запрос по словам: строгий (`websearch_to_tsquery` — все слова, фразы в
 * кавычках) и запасной — любое из слов. Строгий на длинном вопросе
 * («какие сроки оплаты по договору аренды») почти всегда пуст, и при
 * отказе вектора поиск словами не находил бы ничего.
 */
const ASK_CTE = `ask AS (
         SELECT websearch_to_tsquery('russian', $4) AS tsq,
                regexp_replace(plainto_tsquery('russian', $4)::text, ' & ', ' | ', 'g')::tsquery AS anyq
       )`;

/** Сколько фрагментов с любым из слов оценивать в запасном запросе: ранг пересчитывает текст. */
const LOOSE_SAMPLE = 1_000;

/**
 * Русская морфология: $4 — запрос, $5 — сколько кандидатов. Запасной
 * запрос выполняется, только если строгий пуст (условие одноразового
 * плана), и оценивает ограниченную выборку: частое слово совпадает с
 * большей частью базы, а `ts_rank_cd` разбирает текст каждой строки.
 */
const FTS_CTE = `fts_strict AS (
         SELECT c.id, 1 + ts_rank_cd(to_tsvector('russian', c.content), ask.tsq) AS score
           FROM knowledge_chunks c
           JOIN knowledge_documents d
             ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
           LEFT JOIN knowledge_collections k ON k.id = d.collection_id
          CROSS JOIN ask
          WHERE to_tsvector('russian', c.content) @@ ask.tsq
            AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, true)))
          ORDER BY score DESC, c.id
          LIMIT $5
       ),
       fts_loose AS (
         SELECT sample.id, ts_rank_cd(to_tsvector('russian', sample.content), ask.anyq) AS score
           FROM (
             SELECT c.id, c.content
               FROM knowledge_chunks c
               JOIN knowledge_documents d
                 ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
               LEFT JOIN knowledge_collections k ON k.id = d.collection_id
              CROSS JOIN ask
              WHERE NOT EXISTS (SELECT 1 FROM fts_strict)
                AND to_tsvector('russian', c.content) @@ ask.anyq
                AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, true)))
              LIMIT ${LOOSE_SAMPLE}
           ) sample
          CROSS JOIN ask
          ORDER BY score DESC, sample.id
          LIMIT $5
       ),
       fts AS (
         SELECT id, score FROM fts_strict
         UNION ALL
         SELECT id, score FROM fts_loose
       )`;

/**
 * Триграммы: слова запроса — параметры с $6. Две ветки, каждая на своём
 * индексе 091: по тексту фрагмента и по названию документа — фамилия или
 * номер бывают только в имени файла («Иванов — договор.pdf»). Одно `OR`
 * по столбцам двух таблиц индексы не использует: план — полный перебор
 * фрагментов. Документ, найденный по названию, представлен одним первым
 * фрагментом: иначе все его фрагменты с одной оценкой вытеснили бы
 * совпадения по тексту. Чем больше слов совпало и чем точнее, тем выше.
 */
function trigramCte(count: number): string {
  const terms = Array.from({ length: count }, (_, index) => `$${index + 6}`);
  const similarity = (column: string): string => terms.map((term) => `word_similarity(${term}, ${column})`).join(" + ");
  const matches = (column: string): string => terms.map((term) => `${term} <% ${column}`).join(" OR ");
  return `trgm_text AS (
         SELECT c.id, (${similarity("c.content")}) AS score
           FROM knowledge_chunks c
           JOIN knowledge_documents d
             ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
           LEFT JOIN knowledge_collections k ON k.id = d.collection_id
          WHERE (${matches("c.content")})
            AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, true)))
          ORDER BY score DESC, c.id
          LIMIT $5
       ),
       trgm_name AS (
         SELECT first.id, (${similarity("d.name")}) AS score
           FROM knowledge_documents d
           LEFT JOIN knowledge_collections k ON k.id = d.collection_id
          CROSS JOIN LATERAL (
            SELECT c.id
              FROM knowledge_chunks c
             WHERE c.document_id = d.id
               AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, true)))
             ORDER BY c.ordinal
             LIMIT 1
          ) first
          WHERE (${matches("d.name")})
            AND (d.user_id = $1 OR d.product_verified)
          ORDER BY score DESC, d.id
          LIMIT $5
       ),
       trgm AS (
         SELECT id, max(score) AS score
           FROM (SELECT id, score FROM trgm_text UNION ALL SELECT id, score FROM trgm_name) found
          GROUP BY id
          ORDER BY score DESC, id
          LIMIT $5
       )`;
}

/**
 * Векторная половина на pgvector — прежние векторы (1536). Фрагменты без
 * вектора (их стало можно хранить с K2: новые векторы живут в Qdrant) в
 * отбор не входят: `NULL` в сортировке по расстоянию занимал бы места в
 * списке, ничего не значащие.
 */
export async function pgvectorCandidates(
  db: Database,
  scope: SearchScope,
  vector: readonly number[],
  limit: number,
): Promise<ScoredRow[]> {
  const { rows } = await db.withUserScope(
    { userId: scope.userId, label: "knowledge.search.pgvector", inherit: true },
    async () => await db.query<ScoredRow>(
      `SELECT c.id::text AS id, 1 - (c.embedding <=> $4::vector) AS score
         FROM knowledge_chunks c
         JOIN knowledge_documents d
           ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
         LEFT JOIN knowledge_collections k ON k.id = d.collection_id
        WHERE c.embedding IS NOT NULL
          AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, true)))
        ORDER BY c.embedding <=> $4::vector, c.id
        LIMIT $5`,
      [...scopeValues(scope), `[${vector.join(",")}]`, limit],
    ),
  );
  return rows;
}

/**
 * Текст и источник кандидатов по id. Видимость проверяется ещё раз:
 * точка Qdrant могла пережить удаление документа или выключение
 * коллекции, а id из индекса — не разрешение на чтение.
 */
export async function hydrateChunks(db: Database, scope: SearchScope, ids: readonly string[]): Promise<ChunkRow[]> {
  if (!ids.length) return [];
  const { rows } = await db.withUserScope(
    { userId: scope.userId, label: "knowledge.search.hydrate", inherit: true },
    async () => await db.query<ChunkRow>(
      `SELECT c.id::text AS id, c.document_id::text AS document_id, c.ordinal, c.content, c.content_hash,
              c.page_start, c.page_end, c.section, c.subsection, c.heading,
              d.name AS document_name, c.product_verified AS global
         FROM knowledge_chunks c
         JOIN knowledge_documents d
           ON d.id = c.document_id AND (d.user_id = $1 OR d.product_verified)
         LEFT JOIN knowledge_collections k ON k.id = d.collection_id
        WHERE c.id = ANY($4::bigint[])
          AND ((c.user_id = $1 AND $2::boolean) OR (c.product_verified AND $3::boolean AND COALESCE(k.enabled, true)))`,
      [...scopeValues(scope), ids],
    ),
  );
  return rows;
}

/**
 * Соседние фрагменты: `ordinal ± n` того же документа по уникальному
 * `(document_id, ordinal)`. Документ уже прошёл видимость вместе с
 * найденным фрагментом; условие владельца здесь — та же граница.
 */
export async function neighborChunks(
  db: Database,
  userId: number,
  wanted: ReadonlyArray<{ documentId: string; ordinal: number }>,
): Promise<NeighborRow[]> {
  if (!wanted.length) return [];
  const { rows } = await db.withUserScope(
    { userId, label: "knowledge.search.neighbors", inherit: true },
    async () => await db.query<NeighborRow>(
      `SELECT c.document_id::text AS document_id, c.ordinal, c.content
         FROM knowledge_chunks c
         JOIN unnest($2::uuid[], $3::integer[]) AS want(document_id, ordinal)
           ON want.document_id = c.document_id AND want.ordinal = c.ordinal
        WHERE c.user_id = $1 OR c.product_verified`,
      [userId, wanted.map((item) => item.documentId), wanted.map((item) => item.ordinal)],
    ),
  );
  return rows;
}

export interface ActiveVersion {
  version: number;
  dimension: number;
  /** Мера близости: у Euclid оценка Qdrant — расстояние, меньше — ближе. */
  distance: string;
}

/** Активная версия эмбеддингов: её модель считает вектор запроса для Qdrant. */
export async function activeEmbeddingVersion(db: Database): Promise<ActiveVersion | null> {
  const { rows } = await db.query<ActiveVersion>(
    `SELECT version, dimension, distance
       FROM knowledge_embedding_versions
      WHERE status = 'active'
      LIMIT 1`,
  );
  return rows[0] ? { version: Number(rows[0].version), dimension: Number(rows[0].dimension), distance: String(rows[0].distance) } : null;
}

/** Включённые коллекции общей базы: только по ним ищет Qdrant. */
export async function enabledCollections(db: Database): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text AS id
       FROM knowledge_collections
      WHERE enabled`,
  );
  return rows.map((row) => row.id);
}
