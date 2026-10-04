/**
 * Поиск по загруженным документам.
 *
 * Это не второй RAG и не память агента: инструмент `knowledge_search`
 * просто зарегистрирован, а когда его позвать, решает Letta (инварианты
 * 13 и 17). Найденное — данные, а не инструкции: конверт недоверенного
 * содержимого надевает инструмент при выдаче модели.
 *
 * Два пути, выбор — в панели (`src/knowledge/search-settings.ts`):
 *
 * - `legacy` — прежний поиск: FTS `simple` и pgvector, слияние RRF одним
 *   запросом. Умолчание и откат.
 * - `hybrid`, `vector`, `lexical` — конвейер K4 (docs/knowledge-base.md):
 *
 *     вектор (pgvector или Qdrant)  ┐
 *     FTS russian                   ├→ RRF → разнообразие → reranker
 *     триграммы                     ┘   → лучшие → соседние фрагменты
 *                                         в бюджете → источники
 *
 * Отказ векторной половины (провайдер эмбеддингов, Qdrant) не роняет
 * поиск: остаются слова, ответ помечен `degraded`. Отказ reranker — порядок
 * RRF. Теневой режим ищет вторым источником векторов в фоне и пишет только
 * метрики совпадения.
 */

import type { Database } from "../db.js";
import { QdrantError } from "./qdrant-client.js";
import type { KnowledgeVectorStore } from "./vector-store.js";
import { recordKnowledgeSearch, recordKnowledgeShadow, recordKnowledgeStage, type KnowledgeSearchOutcome } from "./metrics.js";
import {
  assemblePassages,
  citeOf,
  diversify,
  fuseRankedLists,
  pagesOf,
  sectionPathOf,
  trigramTerms,
  type KnowledgeSignal,
  type RankedList,
} from "./search-fusion.js";
import {
  activeEmbeddingVersion,
  enabledCollections,
  hydrateChunks,
  legacyCandidates,
  lexicalCandidates,
  neighborChunks,
  pgvectorCandidates,
  type ActiveVersion,
  type ChunkRow,
  type SearchScope,
} from "./search-queries.js";
import {
  LEGACY_SEARCH_SETTINGS,
  type KnowledgeSearchMode,
  type KnowledgeSearchSettings,
  type KnowledgeVectorBackend,
} from "./search-settings.js";

export interface KnowledgeHitScores {
  rrf: number;
  vector?: number;
  vectorRank?: number;
  fts?: number;
  ftsRank?: number;
  trgm?: number;
  trgmRank?: number;
  /** Оценка reranker; null — reranker этого кандидата не оценил. */
  rerank?: number | null;
}

export interface KnowledgeHit {
  documentId: string;
  documentName: string;
  ordinal: number;
  content: string;
  /** Совместный ранг: чем больше, тем выше. */
  score: number;
  /**
   * Чем нашлось. Прежний поиск: `fts`, `vector` или `both`; конвейер —
   * способы через «+»: `vector+fts`, `trgm`.
   */
  matched: string;
  /** Конвейер K4: источник и контекст. */
  base?: "personal" | "shared";
  cite?: string;
  pages?: string | null;
  section?: string | null;
  before?: string;
  after?: string;
  truncated?: boolean;
  /** Оценки этапов — для диагностики в панели (K5), модели не отдаются. */
  scores?: KnowledgeHitScores;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** Векторная половина не работала: поиск шёл только словами. */
  degraded: boolean;
  /** Поиск выключен в панели: ничего не искалось. */
  disabled?: boolean;
  /** Найдено больше, чем поместилось в бюджет ответа. */
  omitted?: number;
  mode?: KnowledgeSearchMode;
  /** Конвейер K4: что было на этапах — для диагностики и метрик. */
  diagnostics?: {
    vectorBackend: KnowledgeVectorBackend | null;
    rerank: "off" | "ok" | "failed";
    candidates: number;
    /** Запрос триграмм не уложился в свою границу времени: остались слова FTS. */
    trigram?: "timeout";
    timings: Partial<Record<"vector" | "lexical" | "rerank" | "total", number>>;
  };
}

export interface RerankRequest {
  providerId: string;
  model: string;
  query: string;
  documents: readonly string[];
}

export interface KnowledgeSearchDeps {
  /** Настройки поиска; без них — прежний поиск. Читаются при каждом вызове. */
  settings?: () => KnowledgeSearchSettings;
  /** Вектор запроса в пространстве версии эмбеддингов — для Qdrant. */
  embedVersion?: (text: string, version: { version: number; dimension: number }, signal?: AbortSignal) => Promise<number[]>;
  /** Индекс Qdrant; null — не настроен (нет `QDRANT_API_KEY`). */
  vectors?: KnowledgeVectorStore | null;
  rerank?: (request: RerankRequest, signal?: AbortSignal) => Promise<Array<number | null>>;
  /** Граница времени векторной половины; по умолчанию 8 с. */
  vectorTimeoutMs?: number;
}

/** Кандидатов от каждого способа: задание — «top 20–40» до слияния. */
const CANDIDATES = 30;
/** Сколько слитых кандидатов читать из PostgreSQL: с запасом на отсеянные. */
const HYDRATE_LIMIT = 60;
/** Сколько лучших после разнообразия отдать reranker. */
const RERANK_CANDIDATES = 30;
/** Кандидат для reranker — путь заголовков и текст, не длиннее этого. */
const RERANK_DOCUMENT_CHARS = 4_000;
/** Reranker в интерактивном ходе: дольше ждать нельзя, есть порядок RRF. */
const RERANK_TIMEOUT_MS = 4_000;
/** Итог конвейера — «final top 5–10». */
const MAX_FINAL = 10;
/** Коллекции кэшируются; гидратация повторно проверяет их видимость. */
const CATALOG_TTL_MS = 30_000;
/** Векторная половина в интерактивном ходе: вектор запроса и поиск по индексу. */
const VECTOR_TIMEOUT_MS = 8_000;
/** Теневых поисков одновременно — больше не нужно: это выборка для сравнения. */
const SHADOW_CONCURRENCY = 2;
const SHADOW_TIMEOUT_MS = 10_000;
/** Совпадение теневого сравнения считается по первым десяти. */
const SHADOW_DEPTH = 10;

type VectorOutcome =
  | { ok: true; list: RankedList }
  | { ok: false };

export class KnowledgeSearch {
  private catalog: { at: number; collections: string[] } | null = null;
  private shadowRunning = 0;

  constructor(
    private readonly db: Database,
    /** Прежний вектор запроса (1536, pgvector). Без него векторная половина на pgvector не работает. */
    private readonly embed?: (text: string, signal?: AbortSignal) => Promise<number[]>,
    private readonly deps: KnowledgeSearchDeps = {},
  ) {}

  async search(
    userId: number,
    query: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<KnowledgeSearchResult> {
    const settings = this.deps.settings?.() ?? LEGACY_SEARCH_SETTINGS;
    const clean = query.trim().slice(0, 1_000);
    if (!settings.enabled || (!settings.privateEnabled && !settings.globalEnabled)) {
      recordKnowledgeSearch(settings.mode, "disabled");
      return { hits: [], degraded: false, disabled: true, mode: settings.mode };
    }
    if (!clean) return { hits: [], degraded: false };
    const scope: SearchScope = { userId, privateEnabled: settings.privateEnabled, globalEnabled: settings.globalEnabled };
    const started = Date.now();
    let failed = true;
    try {
      const result = settings.mode === "legacy"
        ? await this.legacy(scope, clean, options)
        : await this.pipeline(scope, clean, settings, options);
      failed = false;
      // Прежний поиск сам векторный список не отдаёт: в тени ищется обоими
      // источниками. Конвейер запускает тень сам, со своим списком.
      if (settings.shadow && settings.mode === "legacy") this.shadow(scope, clean, null);
      const outcome: KnowledgeSearchOutcome = result.degraded ? "degraded" : result.hits.length ? "ok" : "empty";
      recordKnowledgeSearch(settings.mode, outcome);
      return result;
    } finally {
      recordKnowledgeStage("search", Date.now() - started, failed);
    }
  }

  // ---------------------------------------------------------------
  // прежний поиск
  // ---------------------------------------------------------------

  /**
   * Прежний запрос: FTS `simple` и pgvector одним SQL. Изменены только
   * границы: документ присоединяется с условием владельца (без него
   * граница арендатора отклоняла запрос), фрагменты без вектора не
   * занимают места в векторном списке, переключатели личной и общей базы
   * и выключенные коллекции действуют и здесь.
   */
  private async legacy(scope: SearchScope, clean: string, options: { limit?: number; signal?: AbortSignal }): Promise<KnowledgeSearchResult> {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
    let vector: string | null = null;
    if (this.embed) {
      try {
        vector = `[${(await this.embed(clean, options.signal)).join(",")}]`;
      } catch {
        // Вектор не роняет поиск: провайдер эмбеддингов может лежать, а
        // найти по словам всё ещё можно.
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        vector = null;
      }
    }
    const rows = await legacyCandidates(this.db, scope, clean, limit, vector);
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
      mode: "legacy",
    };
  }

  // ---------------------------------------------------------------
  // конвейер K4
  // ---------------------------------------------------------------

  private async pipeline(
    scope: SearchScope,
    clean: string,
    settings: KnowledgeSearchSettings,
    options: { limit?: number; signal?: AbortSignal },
  ): Promise<KnowledgeSearchResult> {
    const limit = Math.min(Math.max(options.limit ?? 5, 1), MAX_FINAL);
    const timings: NonNullable<KnowledgeSearchResult["diagnostics"]>["timings"] = {};
    const started = Date.now();
    const wantsVector = settings.mode !== "lexical";
    const wantsLexical = settings.mode !== "vector";

    const [vector, lexical] = await Promise.all([
      wantsVector ? this.timed("vector", timings, () => this.vectorList(settings.vectorBackend, scope, clean, options.signal)) : null,
      wantsLexical ? this.timed("lexical", timings, () => this.lexicalLists(scope, clean)) : null,
    ]);
    const degraded = vector !== null && !vector.ok;
    // Векторный режим без вектора — те же слова, что и при отказе в
    // гибридном: человек получает найденное, а не пустоту.
    const words = degraded && !wantsLexical ? await this.timed("lexical", timings, () => this.lexicalLists(scope, clean)) : lexical;
    const lists = [...(vector?.ok ? [vector.list] : []), ...(words?.lists ?? [])];

    const fused = fuseRankedLists(lists).slice(0, HYDRATE_LIMIT);
    const rows = new Map((await hydrateChunks(this.db, scope, fused.map((item) => item.id))).map((row) => [row.id, row]));
    const candidates = fused.flatMap((item) => {
      const row = rows.get(item.id);
      return row ? [{ ...item, row, documentId: row.document_id, contentHash: row.content_hash }] : [];
    });
    let ordered = diversify(candidates, RERANK_CANDIDATES);
    let rerank: "off" | "ok" | "failed" = "off";
    const rerankScores = new Map<string, number | null>();
    if (settings.rerank && this.deps.rerank && ordered.length > 1) {
      const rerankStarted = Date.now();
      try {
        const signal = options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(RERANK_TIMEOUT_MS)])
          : AbortSignal.timeout(RERANK_TIMEOUT_MS);
        const scores = await this.deps.rerank({
          ...settings.rerank,
          query: clean,
          documents: ordered.map((item) => rerankText(item.row)),
        }, signal);
        ordered.forEach((item, index) => rerankScores.set(item.id, scores[index] ?? null));
        // Неоценённые — после оценённых, между собой — в порядке RRF.
        ordered = ordered
          .map((item, index) => ({ item, index, score: scores[index] ?? null }))
          .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.index - b.index)
          .map((entry) => entry.item);
        rerank = "ok";
      } catch {
        // Reranker необязателен: отказ или таймаут оставляют порядок RRF.
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
        rerank = "failed";
      } finally {
        timings.rerank = Date.now() - rerankStarted;
      }
    }
    const final = diversify(ordered, limit).map((item) => ({
      ...item,
      ordinal: Number(item.row.ordinal),
      content: item.row.content,
    }));

    const depth = settings.neighbors;
    const neighbors = depth > 0 && final.length
      ? await neighborChunks(this.db, scope, neighborKeys(final, depth))
      : [];
    // Источник и раздел уходят модели вместе с текстом — их длина входит в бюджет.
    const passages = assemblePassages(
      final,
      neighbors.map((row) => ({ documentId: row.document_id, ordinal: Number(row.ordinal), content: row.content })),
      { depth, overhead: (hit) => sourceOverhead(hit.row) },
    );
    const omitted = final.length - passages.length;

    if (settings.shadow) {
      this.shadow(scope, clean, vector?.ok ? { backend: settings.vectorBackend, ids: vector.list.ids } : null);
    }
    timings.total = Date.now() - started;
    return {
      hits: passages.map(({ hit, content, before, after, truncated }) => {
        const row = hit.row;
        const source = {
          documentName: row.document_name,
          pageStart: row.page_start,
          pageEnd: row.page_end,
          section: row.section,
          subsection: row.subsection,
          heading: row.heading,
        };
        const signals = (["vector", "fts", "trgm"] as const).filter((signal) => hit.ranks[signal] !== undefined);
        return {
          documentId: row.document_id,
          documentName: row.document_name,
          ordinal: hit.ordinal,
          content,
          score: hit.rrf,
          matched: signals.join("+"),
          base: row.global ? "shared" : "personal",
          cite: citeOf(source),
          pages: pagesOf(source),
          section: sectionPathOf(source),
          ...(before ? { before } : {}),
          ...(after ? { after } : {}),
          truncated,
          scores: {
            rrf: hit.rrf,
            ...signalScores(hit, "vector"),
            ...signalScores(hit, "fts"),
            ...signalScores(hit, "trgm"),
            ...(rerankScores.has(hit.id) ? { rerank: rerankScores.get(hit.id)! } : {}),
          },
        };
      }),
      degraded,
      mode: settings.mode,
      ...(omitted > 0 ? { omitted } : {}),
      diagnostics: {
        vectorBackend: wantsVector ? settings.vectorBackend : null,
        rerank,
        candidates: candidates.length,
        ...(words?.trigramTimedOut ? { trigram: "timeout" as const } : {}),
        timings,
      },
    };
  }

  private async lexicalLists(scope: SearchScope, clean: string): Promise<{ lists: RankedList[]; trigramTimedOut: boolean }> {
    const found = await lexicalCandidates(this.db, scope, clean, trigramTerms(clean), CANDIDATES);
    return { lists: [toList("fts", found.fts), toList("trgm", found.trgm)], trigramTimedOut: found.trigramTimedOut };
  }

  /**
   * Векторный список из выбранного источника. Отказ — `ok: false`, а не
   * исключение: вызывающий переходит на слова. Отмена хода — исключение:
   * повторять и подменять нечего. Своя граница времени: зависший провайдер
   * эмбеддингов держал бы весь ход до таймаута провайдера, а слова уже
   * найдены.
   */
  private async vectorList(
    backend: KnowledgeVectorBackend,
    scope: SearchScope,
    clean: string,
    turn?: AbortSignal,
  ): Promise<VectorOutcome> {
    // Обычный таймер, а не `AbortSignal.timeout`: тот не держит цикл
    // событий, и срок мог бы не наступить вовсе. Снимается в finally.
    const expiry = new AbortController();
    const timer = setTimeout(() => expiry.abort(new Error("knowledge_vector_timeout")), this.deps.vectorTimeoutMs ?? VECTOR_TIMEOUT_MS);
    const deadline = expiry.signal;
    const signal = turn ? AbortSignal.any([turn, deadline]) : deadline;
    try {
      if (backend === "pgvector") {
        if (!this.embed) return { ok: false };
        // Прежний `embed` роутера задержку не пишет — её пишет поиск.
        const vector = await this.timedEmbedding(() => this.embed!(clean, signal));
        return { ok: true, list: toList("vector", await pgvectorCandidates(this.db, scope, vector, CANDIDATES)) };
      }
      const store = this.deps.vectors;
      if (!store || !this.deps.embedVersion) return { ok: false };
      const catalog = await this.catalogue();
      // Индекс не включали — векторной половины нет; это та же
      // урезанная выдача, что и при отказе Qdrant.
      if (!catalog.version) return { ok: false };
      const version = catalog.version;
      // Задержку эмбеддинга версии пишет клиент роутера (`embedMany`).
      const vector = await this.deps.embedVersion(clean, { version: version.version, dimension: version.dimension }, signal);
      // Версия называется явно, а не через alias: вектор запроса посчитан
      // моделью этой версии, и искать им в другом пространстве нельзя.
      const options = { limit: CANDIDATES, version: version.version, ...(signal ? { signal } : {}) };
      const [mine, shared] = await Promise.all([
        scope.privateEnabled ? store.searchPrivate(scope.userId, vector, options) : [],
        scope.globalEnabled ? store.searchGlobal(vector, catalog.collections, options) : [],
      ]);
      // Обе коллекции — одной версии и одной меры близости: оценки
      // сравнимы и сливаются сортировкой. У Euclid оценка — расстояние:
      // ближе — меньше.
      const order = version.distance === "Euclid" ? 1 : -1;
      const hits = [...mine, ...shared].sort((a, b) => order * (a.score - b.score)).slice(0, CANDIDATES);
      return {
        ok: true,
        list: {
          signal: "vector",
          ids: hits.map((hit) => String(hit.chunkId)),
          scores: new Map(hits.map((hit) => [String(hit.chunkId), hit.score])),
        },
      };
    } catch (error) {
      // Отменён ход — исключение. Своя граница времени — отказ половины:
      // Qdrant называет её тоже `qdrant_cancelled`, поэтому решает сигнал хода.
      if (turn?.aborted) throw error;
      if (error instanceof QdrantError && error.code === "qdrant_cancelled" && !deadline.aborted) throw error;
      return { ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Версию перечитываем на каждый поиск: после K7 старое пространство не используется. */
  private async catalogue(): Promise<{ version: ActiveVersion | null; collections: string[] }> {
    const now = Date.now();
    const [version, collections] = await Promise.all([
      activeEmbeddingVersion(this.db),
      this.catalog && now - this.catalog.at < CATALOG_TTL_MS ? this.catalog.collections : enabledCollections(this.db),
    ]);
    if (!this.catalog || now - this.catalog.at >= CATALOG_TTL_MS) this.catalog = { at: now, collections };
    return { version, collections };
  }

  private async timedEmbedding<T>(work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let failed = true;
    try {
      const result = await work();
      failed = false;
      return result;
    } finally {
      recordKnowledgeStage("embedding", Date.now() - started, failed);
    }
  }

  private async timed<T>(
    stage: "vector" | "lexical",
    timings: NonNullable<KnowledgeSearchResult["diagnostics"]>["timings"],
    work: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    let failed = true;
    try {
      const result = await work();
      failed = typeof result === "object" && result !== null && "ok" in result && result.ok === false;
      return result;
    } finally {
      const elapsed = Date.now() - started;
      timings[stage] = (timings[stage] ?? 0) + elapsed;
      recordKnowledgeStage(stage, elapsed, failed);
    }
  }

  /**
   * Теневое сравнение: тот же запрос вторым источником векторов, в фоне,
   * после ответа. Пишется только совпадение первых десяти результатов —
   * ни запроса, ни найденного. Одновременно — не больше двух: это выборка
   * для решения о переключении (K8), а не вторая копия каждого поиска.
   */
  private shadow(scope: SearchScope, clean: string, primary: { backend: KnowledgeVectorBackend; ids: string[] } | null): void {
    if (this.shadowRunning >= SHADOW_CONCURRENCY || !this.embed || !this.deps.vectors || !this.deps.embedVersion) {
      recordKnowledgeShadow("skipped");
      return;
    }
    this.shadowRunning += 1;
    const started = Date.now();
    const signal = AbortSignal.timeout(SHADOW_TIMEOUT_MS);
    const listOf = async (backend: KnowledgeVectorBackend): Promise<string[] | null> => {
      if (primary?.backend === backend) return primary.ids;
      const outcome = await this.vectorList(backend, scope, clean, signal);
      return outcome.ok ? outcome.list.ids : null;
    };
    // allSettled, а не all: счётчик одновременных сравнений снимается,
    // когда закончились оба поиска, а не при первом отказе.
    void Promise.allSettled([listOf("pgvector"), listOf("qdrant")])
      .then(([left, right]) => [
        left.status === "fulfilled" ? left.value : null,
        right.status === "fulfilled" ? right.value : null,
      ])
      .then(([pgvector, qdrant]) => {
        if (!pgvector || !qdrant) {
          recordKnowledgeShadow("error");
          return;
        }
        const left = pgvector.slice(0, SHADOW_DEPTH);
        const right = new Set(qdrant.slice(0, SHADOW_DEPTH));
        const size = Math.max(left.length, right.size);
        if (!size) {
          recordKnowledgeShadow("empty");
          return;
        }
        recordKnowledgeShadow("ok", left.filter((id) => right.has(id)).length / size);
      })
      .catch(() => recordKnowledgeShadow("error"))
      .finally(() => {
        this.shadowRunning -= 1;
        recordKnowledgeStage("shadow", Date.now() - started, false);
      });
  }
}

function toList(signal: KnowledgeSignal, rows: ReadonlyArray<{ id: string; score: string | number }>): RankedList {
  return {
    signal,
    ids: rows.map((row) => String(row.id)),
    scores: new Map(rows.map((row) => [String(row.id), Number(row.score)])),
  };
}

function signalScores(
  hit: { ranks: Partial<Record<KnowledgeSignal, number>>; scores: Partial<Record<KnowledgeSignal, number>> },
  signal: KnowledgeSignal,
): Partial<KnowledgeHitScores> {
  if (hit.ranks[signal] === undefined) return {};
  return {
    [signal]: hit.scores[signal],
    [`${signal}Rank`]: hit.ranks[signal],
  } as Partial<KnowledgeHitScores>;
}

/** Сколько знаков ответа занимает источник фрагмента: название, страницы, путь разделов и имена полей. */
function sourceOverhead(row: ChunkRow): number {
  const section = sectionPathOf({ section: row.section, subsection: row.subsection, heading: row.heading }) ?? "";
  return 2 * row.document_name.length + section.length * 2 + 80;
}

/** Текст кандидата для reranker: путь заголовков несёт смысл, которого нет в абзаце. */
function rerankText(row: ChunkRow): string {
  const path = sectionPathOf({ section: row.section, subsection: row.subsection, heading: row.heading });
  const text = path ? `${path}\n${row.content}` : row.content;
  return text.slice(0, RERANK_DOCUMENT_CHARS);
}

function neighborKeys(hits: ReadonlyArray<{ documentId: string; ordinal: number }>, depth: number): Array<{ documentId: string; ordinal: number }> {
  const seen = new Set<string>();
  const keys: Array<{ documentId: string; ordinal: number }> = [];
  for (const hit of hits) {
    for (let distance = 1; distance <= depth; distance += 1) {
      for (const ordinal of [hit.ordinal - distance, hit.ordinal + distance]) {
        const key = `${hit.documentId}#${ordinal}`;
        if (ordinal < 0 || seen.has(key)) continue;
        seen.add(key);
        keys.push({ documentId: hit.documentId, ordinal });
      }
    }
  }
  return keys;
}
