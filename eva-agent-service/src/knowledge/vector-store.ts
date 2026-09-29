/**
 * Векторный индекс базы знаний поверх Qdrant.
 *
 * Индекс производный (правило 14, docs/knowledge-base.md): документы,
 * фрагменты, права и коллекции живут в PostgreSQL, а здесь — векторы
 * фрагментов и минимальные метаданные для фильтра и ссылки обратно на
 * PostgreSQL. Потерянный индекс перестраивается из PostgreSQL целиком.
 *
 * Две физические коллекции на версию эмбеддингов:
 *
 *   eva_knowledge_private_v<N>  личные базы, арендатор — user_id
 *   eva_knowledge_global_v<N>   общая база администратора, фильтр — collection_id
 *
 * Приложение ищет через alias `eva_knowledge_private` и
 * `eva_knowledge_global`; смена модели — это новая пара коллекций,
 * переиндексация и атомарный перевод alias.
 *
 * Изоляция арендаторов держится здесь и только здесь: фильтр строит этот
 * модуль, а личный поиск без `user_id` не выражается его интерфейсом.
 * `user_id` приходит из серверного контекста хода или сессии, никогда —
 * из аргументов модели, Telegram или браузера.
 */

import { QdrantClient, QdrantError, type QdrantCollectionSpec, type QdrantDistance, type QdrantFilter } from "./qdrant-client.js";

export type KnowledgeScope = "private" | "global";

export const KNOWLEDGE_ALIAS: Readonly<Record<KnowledgeScope, string>> = Object.freeze({
  private: "eva_knowledge_private",
  global: "eva_knowledge_global",
});

export function knowledgeCollection(scope: KnowledgeScope, version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("embedding_version_invalid");
  return `${KNOWLEDGE_ALIAS[scope]}_v${version}`;
}

/** Номер версии из имени физической коллекции; null — имя не наше. */
export function versionOfCollection(name: string | null | undefined): number | null {
  const match = /^eva_knowledge_(?:private|global)_v(\d{1,6})$/u.exec(name ?? "");
  return match ? Number(match[1]) : null;
}

/** Пространство векторов одной версии эмбеддингов: смешивать разные нельзя. */
export interface EmbeddingSpace {
  version: number;
  model: string;
  dimension: number;
  distance: QdrantDistance;
}

/** Необязательная настройка графа — «Настройки → Дополнительно». */
export interface VectorIndexTuning {
  m?: number;
  efConstruct?: number;
  onDisk?: boolean;
}

/** Метаданные точки. Текста фрагмента здесь нет: он живёт в PostgreSQL. */
export interface KnowledgePointPayload {
  chunk_id: number;
  document_id: string;
  /** Строкой: поле-арендатор Qdrant — keyword. null — общая база. */
  user_id: string | null;
  collection_id: string | null;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  mime: string;
  embedding_model: string;
  embedding_version: number;
  created_at: string;
}

export interface KnowledgeVectorPoint {
  chunkId: number;
  vector: number[];
  payload: KnowledgePointPayload;
}

export interface VectorHit {
  chunkId: number;
  documentId: string;
  score: number;
  payload: Partial<KnowledgePointPayload>;
}

export interface SearchOptions {
  limit: number;
  scoreThreshold?: number;
  /** Конкретная версия — для проверки перед переключением; иначе alias. */
  version?: number;
  hnswEf?: number;
  signal?: AbortSignal;
}

function assertUserId(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("knowledge_user_invalid");
  return String(userId);
}

/** Поля payload точки — ровно эти и никаких других (docs/knowledge-base.md). */
const PAYLOAD_FIELDS = [
  "chunk_id", "document_id", "user_id", "collection_id", "page_start", "page_end",
  "section", "mime", "embedding_model", "embedding_version", "created_at",
] as const satisfies ReadonlyArray<keyof KnowledgePointPayload>;

function assertVector(vector: number[], dimension?: number): void {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) throw new Error("embedding_vector_invalid");
  if (dimension !== undefined && vector.length !== dimension) throw new Error("embedding_dimension_invalid");
}

function collectionSpec(scope: KnowledgeScope, space: EmbeddingSpace, tuning: VectorIndexTuning): QdrantCollectionSpec {
  const common = {
    size: space.dimension,
    distance: space.distance,
    onDiskVectors: tuning.onDisk === true,
    onDiskPayload: true,
  };
  if (scope === "private") {
    // Личный поиск всегда с фильтром по человеку: общий граф по всем
    // людям не нужен (m=0), нужны графы внутри каждого (payload_m).
    return {
      ...common,
      hnsw: { m: 0, payload_m: tuning.m ?? 16, ef_construct: tuning.efConstruct ?? 100, on_disk: tuning.onDisk === true },
      indexes: [
        { field: "user_id", schema: "keyword", tenant: true },
        { field: "document_id", schema: "keyword" },
      ],
    };
  }
  return {
    ...common,
    hnsw: { m: tuning.m ?? 16, ef_construct: tuning.efConstruct ?? 100, on_disk: tuning.onDisk === true },
    indexes: [
      { field: "collection_id", schema: "keyword" },
      { field: "document_id", schema: "keyword" },
    ],
  };
}

export class KnowledgeVectorStore {
  constructor(private readonly client: QdrantClient) {}

  /** Готов ли Qdrant. Не бросает. */
  async ready(signal?: AbortSignal): Promise<boolean> {
    return await this.client.ready(signal);
  }

  /**
   * Коллекции версии: создать недостающие, у существующих сверить форму.
   *
   * Коллекция с той же версией, но другой размерностью — это чужое
   * пространство векторов, и писать в неё нельзя: отказ, а не пересоздание.
   *
   * Создание коллекции и её индексов — несколько вызовов. Оборвавшееся
   * посередине оставило бы личную коллекцию без индекса `user_id`, и с
   * `m=0` каждый поиск стал бы полным перебором; поэтому недостающие
   * индексы достраиваются и у существующей коллекции.
   */
  async ensureSpace(space: EmbeddingSpace, tuning: VectorIndexTuning = {}): Promise<void> {
    for (const scope of ["private", "global"] as const) {
      const name = knowledgeCollection(scope, space.version);
      const spec = collectionSpec(scope, space, tuning);
      const info = await this.client.collectionInfo(name);
      if (!info) {
        await this.client.createCollection(name, spec);
        continue;
      }
      if (info.size !== space.dimension || info.distance !== space.distance) {
        throw new Error("vector_space_mismatch");
      }
      for (const index of spec.indexes) {
        if (!info.indexedFields.includes(index.field)) await this.client.createPayloadIndex(name, index);
      }
    }
  }

  /** Коллекции версии: сколько точек и в каком состоянии; null — коллекции нет. */
  async describe(version: number): Promise<Record<KnowledgeScope, Awaited<ReturnType<QdrantClient["collectionInfo"]>>>> {
    return {
      private: await this.client.collectionInfo(knowledgeCollection("private", version)),
      global: await this.client.collectionInfo(knowledgeCollection("global", version)),
    };
  }

  /** На какую версию сейчас смотрят alias; null — поиск ещё не переключали. */
  async activeVersions(): Promise<Record<KnowledgeScope, number | null>> {
    const aliases = await this.client.aliases();
    return {
      private: versionOfCollection(aliases.get(KNOWLEDGE_ALIAS.private)),
      global: versionOfCollection(aliases.get(KNOWLEDGE_ALIAS.global)),
    };
  }

  /** Перевести обе alias на версию одним атомарным запросом. */
  async activate(version: number): Promise<void> {
    const aliases = await this.client.aliases();
    await this.client.switchAliases(
      (["private", "global"] as const).map((scope) => ({
        alias: KNOWLEDGE_ALIAS[scope],
        collection: knowledgeCollection(scope, version),
      })),
      new Set(aliases.keys()),
    );
  }

  /** Удалить коллекции версии. Активную не удалить: сначала переключение. */
  async dropVersion(version: number): Promise<void> {
    const active = await this.activeVersions();
    if (active.private === version || active.global === version) throw new Error("vector_version_active");
    await this.client.deleteCollection(knowledgeCollection("private", version));
    await this.client.deleteCollection(knowledgeCollection("global", version));
  }

  /**
   * Записать векторы фрагментов. Идентификатор точки — id фрагмента в
   * PostgreSQL: повтор той же записи заменяет точку, а не множит её.
   */
  async upsert(scope: KnowledgeScope, space: EmbeddingSpace, points: KnowledgeVectorPoint[], signal?: AbortSignal): Promise<void> {
    for (const point of points) {
      assertVector(point.vector, space.dimension);
      if (!Number.isSafeInteger(point.chunkId) || point.chunkId <= 0 || point.payload.chunk_id !== point.chunkId) {
        throw new Error("knowledge_chunk_invalid");
      }
      if (point.payload.embedding_version !== space.version) throw new Error("vector_space_mismatch");
      // Точка личной базы без владельца нашлась бы у всех, общей с
      // владельцем — только у него. И то и другое — ошибка вызывающего.
      // Владелец — строка id из PostgreSQL: другая форма не совпала бы с
      // фильтром поиска, и точка пропала бы молча.
      if (scope === "private" && (!/^[1-9][0-9]{0,15}$/u.test(point.payload.user_id ?? "") || point.payload.collection_id !== null)) {
        throw new Error("knowledge_scope_invalid");
      }
      if (scope === "global" && (point.payload.user_id !== null || !point.payload.collection_id)) {
        throw new Error("knowledge_scope_invalid");
      }
    }
    await this.client.upsert(
      knowledgeCollection(scope, space.version),
      // Payload собирается по списку полей, а не копией объекта: лишнее
      // поле вызывающего (например, текст фрагмента) в индекс не уйдёт.
      points.map((point) => ({
        id: point.chunkId,
        vector: point.vector,
        payload: Object.fromEntries(PAYLOAD_FIELDS.map((field) => [field, point.payload[field] ?? null])),
      })),
      signal,
    );
  }

  /**
   * Удалить точки документов. Владельца здесь не проверить: id документов
   * вызывающий берёт из PostgreSQL, где владелец уже проверен.
   */
  async deleteDocuments(scope: KnowledgeScope, version: number, documentIds: string[]): Promise<void> {
    if (!documentIds.length) return;
    await this.client.deletePoints(knowledgeCollection(scope, version), {
      filter: { must: [{ key: "document_id", match: { any: documentIds } }] },
    });
  }

  /** Удалить точки фрагментов по id — для точек-сирот, найденных сверкой. */
  async deleteChunks(scope: KnowledgeScope, version: number, chunkIds: number[]): Promise<void> {
    if (!chunkIds.length) return;
    await this.client.deletePoints(knowledgeCollection(scope, version), { points: chunkIds });
  }

  /** Очистить личную базу человека целиком. */
  async deleteUser(version: number, userId: number): Promise<void> {
    await this.client.deletePoints(knowledgeCollection("private", version), {
      filter: { must: [{ key: "user_id", match: { value: assertUserId(userId) } }] },
    });
  }

  /**
   * Личный поиск. Фильтр по владельцу добавляется всегда и не может быть
   * ослаблен вызывающим: другого пути к личным точкам в модуле нет.
   */
  async searchPrivate(userId: number, vector: number[], options: SearchOptions): Promise<VectorHit[]> {
    const owner = assertUserId(userId);
    assertVector(vector);
    return await this.search("private", vector, { must: [{ key: "user_id", match: { value: owner } }] }, options);
  }

  /** Общая база — только по включённым коллекциям; пустой список — пустой ответ. */
  async searchGlobal(vector: number[], collectionIds: string[], options: SearchOptions): Promise<VectorHit[]> {
    assertVector(vector);
    if (!collectionIds.length) return [];
    return await this.search("global", vector, { must: [{ key: "collection_id", match: { any: collectionIds } }] }, options);
  }

  async countPoints(scope: KnowledgeScope, version: number): Promise<number> {
    return await this.client.count(knowledgeCollection(scope, version));
  }

  /** Точек по документам — для сверки с числом фрагментов в PostgreSQL. */
  async documentPointCounts(scope: KnowledgeScope, version: number, limit: number): Promise<Map<string, number>> {
    return await this.client.facet(knowledgeCollection(scope, version), "document_id", { limit });
  }

  /** Страница точек без векторов — для поиска сирот. */
  async scrollChunkIds(
    scope: KnowledgeScope,
    version: number,
    offset: number | string | null,
    limit: number,
  ): Promise<{ chunkIds: number[]; documentIds: string[]; next: number | string | null }> {
    const page = await this.client.scroll(knowledgeCollection(scope, version), {
      limit,
      offset,
      payload: ["document_id"],
    });
    return {
      chunkIds: page.points.map((point) => Number(point.id)).filter((id) => Number.isSafeInteger(id)),
      documentIds: page.points.map((point) => String(point.payload.document_id ?? "")),
      next: page.next,
    };
  }

  private async search(scope: KnowledgeScope, vector: number[], filter: QdrantFilter, options: SearchOptions): Promise<VectorHit[]> {
    const target = options.version === undefined ? KNOWLEDGE_ALIAS[scope] : knowledgeCollection(scope, options.version);
    if (!Number.isFinite(options.limit)) throw new Error("knowledge_limit_invalid");
    const limit = Math.min(Math.max(Math.floor(options.limit), 1), 200);
    let hits;
    try {
      hits = await this.client.query(target, vector, {
        filter,
        limit,
        ...(options.scoreThreshold !== undefined ? { scoreThreshold: options.scoreThreshold } : {}),
        ...(options.hnswEf ? { hnswEf: options.hnswEf } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // Alias ещё не создан — индекс не включали: это пустой ответ, а не
      // авария. Остальные отказы вызывающий превращает в degraded.
      if (error instanceof QdrantError && error.code === "qdrant_not_found") return [];
      throw error;
    }
    return hits.flatMap((hit) => {
      const chunkId = typeof hit.id === "number" ? hit.id : Number(hit.id);
      const documentId = hit.payload.document_id;
      if (!Number.isSafeInteger(chunkId) || typeof documentId !== "string") return [];
      // Точка, чей владелец не совпал с фильтром, означала бы сломанную
      // изоляцию в самом Qdrant: отбрасывается, а не отдаётся.
      if (filter.must?.some((condition) => "key" in condition && condition.key === "user_id"
        && "value" in condition.match && hit.payload.user_id !== condition.match.value)) {
        return [];
      }
      return [{ chunkId, documentId, score: hit.score, payload: hit.payload as Partial<KnowledgePointPayload> }];
    });
  }
}
