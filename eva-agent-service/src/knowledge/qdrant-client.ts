/**
 * Клиент Qdrant — ровно те вызовы REST API, которыми пользуется база знаний.
 *
 * Своим клиентом, а не пакетом `@qdrant/js-client-rest`: нужно полтора
 * десятка вызовов, а пакет тянет за собой генерированный клиент всего API
 * и свои зависимости. Здесь каждый вызов с таймаутом, кодом отказа, по
 * которому поиск уходит в degraded, и счётчиком задержки для /metrics.
 *
 * Клиент ничего не знает о пользователях и базах знаний. Ограничение
 * личного поиска владельцем — дело `vector-store.ts`: только он строит
 * фильтры, и только через него сюда ходит остальной код.
 *
 * Проверено против Qdrant 1.19 (ответы — `{ result, status, time }`, отказ —
 * `{ status: { error } }` с кодом 4xx/5xx).
 */

import { recordQdrantCall, type QdrantOperation } from "./metrics.js";

export type QdrantDistance = "Cosine" | "Dot" | "Euclid";

/** Почему вызов не удался. `unavailable` и `timeout` — повод уйти в degraded. */
export type QdrantErrorCode =
  | "qdrant_unavailable"
  | "qdrant_timeout"
  /** Вызов отменил сам вызывающий: ход отменён, ждать и повторять нечего. */
  | "qdrant_cancelled"
  | "qdrant_unauthorized"
  | "qdrant_not_found"
  | "qdrant_bad_request"
  | "qdrant_server_error"
  | "qdrant_bad_response";

export class QdrantError extends Error {
  constructor(
    readonly code: QdrantErrorCode,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "QdrantError";
  }

  /** Отказ самого сервиса, а не запроса: повтор или degraded, а не исправление. */
  get transient(): boolean {
    return this.code === "qdrant_unavailable"
      || this.code === "qdrant_timeout"
      || this.code === "qdrant_server_error";
  }
}

export type QdrantMatch =
  | { value: string | number | boolean }
  | { any: Array<string | number> };

export type QdrantCondition =
  | { key: string; match: QdrantMatch }
  | { has_id: Array<string | number> };

export interface QdrantFilter {
  must?: QdrantCondition[];
  must_not?: QdrantCondition[];
  should?: QdrantCondition[];
}

export interface QdrantPoint {
  id: number | string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantHit {
  id: number | string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantPayloadIndex {
  field: string;
  schema: "keyword" | "integer" | "uuid" | "datetime";
  /** Поле-арендатор: Qdrant хранит точки одного арендатора рядом. Только keyword/uuid. */
  tenant?: boolean;
}

export interface QdrantCollectionSpec {
  size: number;
  distance: QdrantDistance;
  /** Граф HNSW: m=0 и payload_m — только графы по арендаторам (личная база). */
  hnsw?: { m?: number; ef_construct?: number; payload_m?: number; on_disk?: boolean };
  onDiskVectors?: boolean;
  onDiskPayload?: boolean;
  indexes: QdrantPayloadIndex[];
}

export interface QdrantCollectionInfo {
  status: string;
  /** Приблизительное число точек — для статистики; точное — `count()`. */
  pointsCount: number;
  indexedVectorsCount: number;
  segmentsCount: number;
  size: number | null;
  distance: QdrantDistance | null;
  /** Поля с payload-индексом. */
  indexedFields: string[];
}

export interface QdrantClientOptions {
  url: string;
  apiKey: string;
  /** Предел одного вызова. Поиск укладывается в него с большим запасом. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface CallOptions {
  method?: "GET" | "PUT" | "POST" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
  /** Без ключа: только /readyz и /healthz, которые Qdrant отдаёт всем. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Запись — пачка точек и ожидание применения: дольше поиска. */
const WRITE_TIMEOUT_MS = 60_000;

function codeForStatus(status: number): QdrantErrorCode {
  if (status === 401 || status === 403) return "qdrant_unauthorized";
  if (status === 404) return "qdrant_not_found";
  if (status >= 500) return "qdrant_server_error";
  return "qdrant_bad_request";
}

export class QdrantClient {
  private readonly base: string;
  private readonly call: typeof fetch;

  constructor(private readonly options: QdrantClientOptions) {
    this.base = options.url.replace(/\/+$/u, "");
    this.call = options.fetch ?? fetch;
  }

  /** Готов ли сервис принимать запросы. Не бросает: ответ — да или нет. */
  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request("health", "/readyz", { anonymous: true, timeoutMs: 3_000, signal }, true);
      return true;
    } catch {
      return false;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    const result = await this.request<{ exists?: boolean }>("admin", `/collections/${encodeURIComponent(name)}/exists`);
    return result?.exists === true;
  }

  /** Сведения о коллекции или null, если её нет. */
  async collectionInfo(name: string): Promise<QdrantCollectionInfo | null> {
    let result: Record<string, unknown>;
    try {
      result = await this.request<Record<string, unknown>>("admin", `/collections/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof QdrantError && error.code === "qdrant_not_found") return null;
      throw error;
    }
    const vectors = ((result.config as Record<string, unknown> | undefined)?.params as Record<string, unknown> | undefined)
      ?.vectors as { size?: unknown; distance?: unknown } | undefined;
    const number = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const schema = result.payload_schema;
    return {
      status: String(result.status ?? "unknown"),
      pointsCount: number(result.points_count),
      indexedVectorsCount: number(result.indexed_vectors_count),
      segmentsCount: number(result.segments_count),
      size: typeof vectors?.size === "number" ? vectors.size : null,
      distance: vectors?.distance === "Cosine" || vectors?.distance === "Dot" || vectors?.distance === "Euclid"
        ? vectors.distance
        : null,
      indexedFields: schema && typeof schema === "object" ? Object.keys(schema) : [],
    };
  }

  /** Создать коллекцию и её payload-индексы. Индексы — до первой точки. */
  async createCollection(name: string, spec: QdrantCollectionSpec): Promise<void> {
    await this.request("admin", `/collections/${encodeURIComponent(name)}`, {
      method: "PUT",
      timeoutMs: WRITE_TIMEOUT_MS,
      body: {
        vectors: { size: spec.size, distance: spec.distance, ...(spec.onDiskVectors ? { on_disk: true } : {}) },
        ...(spec.hnsw ? { hnsw_config: spec.hnsw } : {}),
        on_disk_payload: spec.onDiskPayload ?? true,
      },
    });
    for (const index of spec.indexes) await this.createPayloadIndex(name, index);
  }

  /** Payload-индекс поля. Повтор для существующего индекса безвреден. */
  async createPayloadIndex(collection: string, index: QdrantPayloadIndex): Promise<void> {
    await this.request("admin", `/collections/${encodeURIComponent(collection)}/index?wait=true`, {
      method: "PUT",
      timeoutMs: WRITE_TIMEOUT_MS,
      body: {
        field_name: index.field,
        field_schema: index.tenant ? { type: index.schema, is_tenant: true } : index.schema,
      },
    });
  }

  async deleteCollection(name: string): Promise<void> {
    try {
      await this.request("admin", `/collections/${encodeURIComponent(name)}`, { method: "DELETE", timeoutMs: WRITE_TIMEOUT_MS });
    } catch (error) {
      if (error instanceof QdrantError && error.code === "qdrant_not_found") return;
      throw error;
    }
  }

  /** alias → коллекция. */
  async aliases(): Promise<Map<string, string>> {
    const result = await this.request<{ aliases?: Array<{ alias_name?: string; collection_name?: string }> }>("admin", "/aliases");
    const map = new Map<string, string>();
    for (const item of result?.aliases ?? []) {
      if (item.alias_name && item.collection_name) map.set(item.alias_name, item.collection_name);
    }
    return map;
  }

  /**
   * Перевести alias на коллекцию одним запросом.
   *
   * Удаление и создание идут одним списком действий: Qdrant применяет его
   * атомарно, и поиск не видит мгновения, когда alias не указывает никуда.
   */
  async switchAliases(targets: Array<{ alias: string; collection: string }>, existing: ReadonlySet<string>): Promise<void> {
    const actions: unknown[] = [];
    for (const target of targets) {
      if (existing.has(target.alias)) actions.push({ delete_alias: { alias_name: target.alias } });
      actions.push({ create_alias: { collection_name: target.collection, alias_name: target.alias } });
    }
    if (!actions.length) return;
    await this.request("admin", "/collections/aliases", { method: "POST", body: { actions }, timeoutMs: WRITE_TIMEOUT_MS });
  }

  /** Записать точки и дождаться применения: после ответа они уже ищутся. */
  async upsert(collection: string, points: QdrantPoint[], signal?: AbortSignal): Promise<void> {
    if (!points.length) return;
    await this.request("upsert", `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      method: "PUT",
      body: { points },
      timeoutMs: WRITE_TIMEOUT_MS,
      signal,
    });
  }

  async deletePoints(collection: string, selector: { filter: QdrantFilter } | { points: Array<number | string> }): Promise<void> {
    await this.request("delete", `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: "POST",
      body: selector,
      timeoutMs: WRITE_TIMEOUT_MS,
    });
  }

  async query(
    collection: string,
    vector: number[],
    options: { filter?: QdrantFilter; limit: number; scoreThreshold?: number; hnswEf?: number; signal?: AbortSignal },
  ): Promise<QdrantHit[]> {
    const result = await this.request<{ points?: Array<{ id?: unknown; score?: unknown; payload?: unknown }> }>(
      "search",
      `/collections/${encodeURIComponent(collection)}/points/query`,
      {
        method: "POST",
        signal: options.signal,
        body: {
          query: vector,
          limit: options.limit,
          with_payload: true,
          ...(options.filter ? { filter: options.filter } : {}),
          ...(options.scoreThreshold !== undefined ? { score_threshold: options.scoreThreshold } : {}),
          ...(options.hnswEf ? { params: { hnsw_ef: options.hnswEf } } : {}),
        },
      },
    );
    const points = result?.points;
    if (!Array.isArray(points)) throw new QdrantError("qdrant_bad_response", null, "Qdrant вернул ответ без points");
    return points.map((point) => {
      if ((typeof point.id !== "number" && typeof point.id !== "string") || typeof point.score !== "number") {
        throw new QdrantError("qdrant_bad_response", null, "Qdrant вернул точку без id или score");
      }
      return {
        id: point.id,
        score: point.score,
        payload: point.payload && typeof point.payload === "object" ? point.payload as Record<string, unknown> : {},
      };
    });
  }

  async count(collection: string, filter?: QdrantFilter): Promise<number> {
    const result = await this.request<{ count?: unknown }>("count", `/collections/${encodeURIComponent(collection)}/points/count`, {
      method: "POST",
      body: { exact: true, ...(filter ? { filter } : {}) },
    });
    if (typeof result?.count !== "number") throw new QdrantError("qdrant_bad_response", null, "Qdrant вернул count без числа");
    return result.count;
  }

  /** Сколько точек у каждого значения поля: сверка документов одним запросом. */
  async facet(collection: string, key: string, options: { filter?: QdrantFilter; limit: number }): Promise<Map<string, number>> {
    const result = await this.request<{ hits?: Array<{ value?: unknown; count?: unknown }> }>(
      "count",
      `/collections/${encodeURIComponent(collection)}/facet`,
      {
        method: "POST",
        body: { key, limit: options.limit, exact: true, ...(options.filter ? { filter: options.filter } : {}) },
      },
    );
    const map = new Map<string, number>();
    for (const hit of result?.hits ?? []) {
      if ((typeof hit.value === "string" || typeof hit.value === "number") && typeof hit.count === "number") {
        map.set(String(hit.value), hit.count);
      }
    }
    return map;
  }

  /** Пройти точки страницами — без векторов: для сверки нужны только id и payload. */
  async scroll(
    collection: string,
    options: { filter?: QdrantFilter; limit: number; offset?: number | string | null; payload?: string[] },
  ): Promise<{ points: Array<{ id: number | string; payload: Record<string, unknown> }>; next: number | string | null }> {
    const result = await this.request<{ points?: Array<{ id?: unknown; payload?: unknown }>; next_page_offset?: unknown }>(
      "count",
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        method: "POST",
        body: {
          limit: options.limit,
          with_vector: false,
          with_payload: options.payload ?? true,
          ...(options.filter ? { filter: options.filter } : {}),
          ...(options.offset !== undefined && options.offset !== null ? { offset: options.offset } : {}),
        },
      },
    );
    const points = (result?.points ?? []).flatMap((point) =>
      typeof point.id === "number" || typeof point.id === "string"
        ? [{ id: point.id, payload: point.payload && typeof point.payload === "object" ? point.payload as Record<string, unknown> : {} }]
        : []);
    const next = result?.next_page_offset;
    return { points, next: typeof next === "number" || typeof next === "string" ? next : null };
  }

  /**
   * Векторы точек по id. Новая версия документа большей частью повторяет
   * прежнюю, и векторы неизменённых фрагментов берутся отсюда, а не
   * считаются у провайдера заново. Точек, которых нет, в ответе нет.
   */
  async retrieveVectors(collection: string, ids: Array<number | string>, signal?: AbortSignal): Promise<Map<string, number[]>> {
    const vectors = new Map<string, number[]>();
    if (!ids.length) return vectors;
    const result = await this.request<Array<{ id?: unknown; vector?: unknown }>>(
      "count",
      `/collections/${encodeURIComponent(collection)}/points`,
      { method: "POST", body: { ids, with_payload: false, with_vector: true }, signal },
    );
    for (const point of Array.isArray(result) ? result : []) {
      const vector = point.vector;
      if ((typeof point.id === "number" || typeof point.id === "string")
        && Array.isArray(vector) && vector.length > 0 && vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        vectors.set(String(point.id), vector as number[]);
      }
    }
    return vectors;
  }

  /** Снимок коллекции внутри тома Qdrant: быстрое восстановление, не замена перестройки. */
  async createSnapshot(collection: string): Promise<string> {
    const result = await this.request<{ name?: unknown }>("admin", `/collections/${encodeURIComponent(collection)}/snapshots?wait=true`, {
      method: "POST",
      timeoutMs: 10 * 60_000,
    });
    if (typeof result?.name !== "string") throw new QdrantError("qdrant_bad_response", null, "Qdrant не назвал снимок");
    return result.name;
  }

  private async request<T>(
    operation: QdrantOperation,
    path: string,
    options: CallOptions = {},
    raw = false,
  ): Promise<T> {
    // Ход уже отменён: запрос не отправляется и в метрики не попадает —
    // это не вызов Qdrant и не его отказ.
    if (options.signal?.aborted) throw new QdrantError("qdrant_cancelled", null, "Вызов Qdrant отменён");
    const started = Date.now();
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const interrupted = (): QdrantError => options.signal?.aborted
      ? new QdrantError("qdrant_cancelled", null, "Вызов Qdrant отменён")
      : controller.signal.aborted
        ? new QdrantError("qdrant_timeout", null, `Qdrant не ответил за ${timeoutMs} мс`)
        : new QdrantError("qdrant_unavailable", null, "Qdrant недоступен");
    let failed = true;
    try {
      let response: Response;
      let text: string;
      try {
        response = await this.call(`${this.base}${path}`, {
          method: options.method ?? "GET",
          headers: {
            ...(options.anonymous ? {} : { "api-key": this.options.apiKey }),
            ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
        // Тело читается под тем же таймаутом: оборванное чтение — тот же
        // отказ сервиса, а не сырой AbortError мимо degraded.
        text = await response.text();
      } catch {
        // Текст исключения fetch не пересказывается: в нём бывает адрес,
        // а значения ключа — никогда, но и адрес журналу не нужен.
        throw interrupted();
      }
      if (!response.ok) {
        // Описание отказа Qdrant полезно администратору («Vector dimension
        // error: expected dim: 4, got 3») и не содержит ни ключа, ни текста
        // документов: только имена полей и числа.
        let detail = "";
        try {
          detail = String((JSON.parse(text) as { status?: { error?: unknown } }).status?.error ?? "");
        } catch {
          detail = "";
        }
        throw new QdrantError(
          codeForStatus(response.status),
          response.status,
          `Qdrant ответил ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
        );
      }
      if (raw) {
        failed = false;
        return undefined as T;
      }
      let parsed: { result?: T };
      try {
        parsed = JSON.parse(text) as { result?: T };
      } catch {
        throw new QdrantError("qdrant_bad_response", response.status, "Qdrant вернул не JSON");
      }
      failed = false;
      return parsed.result as T;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      recordQdrantCall(operation, Date.now() - started, failed);
    }
  }
}
