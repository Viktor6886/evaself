/**
 * Проверка версии перед переключением: число точек само по себе ничего
 * не доказывает (сирота может заменить недостающий фрагмент). Проверяем
 * каждый id и payload по PostgreSQL, включая владельца и пространство.
 * Текст и векторы для этого не нужны и наружу не выдаются.
 */
import type pg from "pg";
import type { Database } from "../db.js";

import type { EmbeddingSpace, KnowledgeScope, KnowledgeVectorStore } from "./vector-store.js";

type Store = Pick<KnowledgeVectorStore, "describe" | "scrollPoints" | "countPoints">;
const PAGE = 256;
const VALIDATION_MS = 60_000;

/** Все записи точек согласованы с exclusive lock активации K7.
 * Соединение удерживается только во время записи, не расчёта embeddings.
 * При upsert канонические строки фиксируются до завершения Qdrant-записи.
 */
export async function withKnowledgeIndexWrite<T>(
  db: Database, work: (client: pg.PoolClient) => Promise<T>, freezeCanonical = false,
): Promise<T> {
  return await db.withSystemScope("knowledge.index.write", async () => await db.transaction(async (client) => {
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('knowledge.embedding.activation'))");
    if (freezeCanonical) await client.query("LOCK TABLE knowledge_documents, knowledge_chunks IN SHARE MODE");
    return await work(client);
  }), { crossUser: true });
}

export class KnowledgeVersionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const visible = (scope: KnowledgeScope): string => scope === "private"
  ? "c.user_id IS NOT NULL AND d.user_id = c.user_id"
  : "c.user_id IS NULL AND d.user_id IS NULL AND c.product_verified AND d.product_verified AND d.collection_id IS NOT NULL";

/**
 * Вызывается только в транзакции. SHARE блокирует изменения канонических
 * фрагментов до COMMIT переключения, но не чтение/разговоры. Блокировка
 * берётся до снимка и проверки: иначе новая загрузка в конце проверки
 * сделала бы доказательство полноты устаревшим ещё до активации.
 */
export async function validateKnowledgeVersion(
  client: Pick<pg.PoolClient, "query">,
  store: Store,
  space: EmbeddingSpace,
): Promise<Record<KnowledgeScope, number>> {
  await client.query("LOCK TABLE knowledge_documents, knowledge_chunks IN SHARE MODE");
  const deadline = Date.now() + VALIDATION_MS;
  const described = await store.describe(space.version);
  const counts = { private: 0, global: 0 };
  for (const scope of ["private", "global"] as const) {
    const info = described[scope];
    if (!info || info.size !== space.dimension || info.distance !== space.distance) {
      throw new KnowledgeVersionError("vector_space_mismatch", "Коллекции Qdrant отсутствуют или имеют другую размерность/меру близости. Постройте индекс заново.");
    }
    if (!["green", "yellow"].includes(info.status)) {
      throw new KnowledgeVersionError("knowledge_index_unhealthy", "Qdrant сообщает об ошибке коллекции: переключение отложено.");
    }
    const { rows } = await client.query<{ total: string }>(
      `SELECT count(*) AS total FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         -- tenant: system — проверка всего производного индекса; наружу только числа
        WHERE d.status = 'ready' AND (${visible(scope)})`,
    );
    const expected = Number(rows[0]?.total ?? 0);
    const seen = new Set<number>();
    const offsets = new Set<number | string>();
    let offset: number | string | null = null;
    do {
      if (Date.now() > deadline) throw new KnowledgeVersionError("knowledge_validation_timeout", "Проверка полноты не уложилась в минуту. Поиск продолжает работать по прежней версии.");
      const page = await store.scrollPoints(scope, space.version, offset, PAGE);
      const ids = page.points.map((point) => Number(point.id));
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) || new Set(ids).size !== ids.length) {
        throw new KnowledgeVersionError("knowledge_index_incomplete", "Индекс содержит неверные или повторяющиеся id. Выполните сверку и перестройку.");
      }
      const found = ids.length ? await client.query<{ id: string; document_id: string; user_id: string | null; collection_id: string | null }>(
        `SELECT c.id::text AS id, c.document_id::text AS document_id, c.user_id, d.collection_id
           FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
           -- tenant: system — проверка payload по каноническому владельцу; данные не возвращаются клиенту
          WHERE c.id = ANY($1::bigint[]) AND d.status = 'ready' AND (${visible(scope)})`,
        [ids],
      ) : { rows: [] };
      const canonical = new Map(found.rows.map((row) => [Number(row.id), row]));
      for (const point of page.points) {
        const id = Number(point.id);
        const row = canonical.get(id);
        const payload = point.payload;
        if (!row || payload.chunk_id !== id || payload.document_id !== row.document_id
          || payload.user_id !== (row.user_id === null ? null : String(row.user_id))
          || payload.collection_id !== (scope === "global" ? row.collection_id : null)
          || payload.embedding_version !== space.version || payload.embedding_model !== space.model) {
          throw new KnowledgeVersionError("knowledge_index_incomplete", "Индекс не совпадает с PostgreSQL по фрагментам, владельцам или модели. Выполните сверку и перестройку версии.");
        }
        seen.add(id);
      }
      offset = page.next;
      if (offset !== null) {
        if (!page.points.length || offsets.has(offset)) throw new KnowledgeVersionError("knowledge_index_incomplete", "Qdrant вернул некорректную страницу проверки индекса.");
        offsets.add(offset);
      }
    } while (offset !== null);
    // Повторный exact count замечает изменение индекса во время обхода.
    if (seen.size !== expected || await store.countPoints(scope, space.version) !== expected) {
      throw new KnowledgeVersionError("knowledge_index_incomplete", "Не все фрагменты PostgreSQL представлены в индексе. Дождитесь индексации или постройте версию заново.");
    }
    counts[scope] = expected;
  }
  return counts;
}
