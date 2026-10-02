/**
 * Настройки поиска по базе знаний (docs/knowledge-base.md, «Поиск (K4)»).
 *
 * Все живут в панели и читаются при каждом поиске: переключатель действует
 * со следующего вызова `knowledge_search`, без перезапуска. Умолчания
 * повторяют прежнее поведение: режим `legacy`, векторы pgvector, reranker
 * и теневой режим выключены.
 */

import type { Config } from "../config.js";

/**
 * `legacy` — прежний поиск: pgvector и FTS `simple`, слияние RRF.
 * `hybrid` — вектор, русская морфология и триграммы, RRF, разнообразие,
 * reranker, соседние фрагменты и источники. `vector` и `lexical` — одна
 * половина того же конвейера: для сравнения и для отката.
 */
export const KNOWLEDGE_SEARCH_MODES = ["legacy", "hybrid", "vector", "lexical"] as const;
export type KnowledgeSearchMode = (typeof KNOWLEDGE_SEARCH_MODES)[number];

/** Откуда векторная половина: pgvector — до K8 основной, Qdrant — после. */
export const KNOWLEDGE_VECTOR_BACKENDS = ["pgvector", "qdrant"] as const;
export type KnowledgeVectorBackend = (typeof KNOWLEDGE_VECTOR_BACKENDS)[number];

export function parseKnowledgeSearchMode(value: unknown, fallback: KnowledgeSearchMode): KnowledgeSearchMode {
  return KNOWLEDGE_SEARCH_MODES.includes(value as KnowledgeSearchMode) ? value as KnowledgeSearchMode : fallback;
}

export function parseKnowledgeVectorBackend(value: unknown, fallback: KnowledgeVectorBackend): KnowledgeVectorBackend {
  return KNOWLEDGE_VECTOR_BACKENDS.includes(value as KnowledgeVectorBackend) ? value as KnowledgeVectorBackend : fallback;
}

export interface KnowledgeSearchSettings {
  /** Общий выключатель поиска: выключенный отвечает `disabled`, ничего не удаляя. */
  enabled: boolean;
  mode: KnowledgeSearchMode;
  vectorBackend: KnowledgeVectorBackend;
  /** Теневое сравнение pgvector и Qdrant в фоне: только метрики, ответ не меняется. */
  shadow: boolean;
  privateEnabled: boolean;
  globalEnabled: boolean;
  /** Reranker: провайдер реестра Router и модель; null — этап выключен. */
  rerank: { providerId: string; model: string } | null;
  /** Сколько соседних фрагментов с каждой стороны добавить, если хватит бюджета. */
  neighbors: number;
}

export type KnowledgeSearchConfig = Pick<
  Config,
  | "knowledgeSearchEnabled" | "knowledgeSearchMode" | "knowledgeVectorBackend" | "knowledgeSearchShadow"
  | "knowledgePrivateEnabled" | "knowledgeGlobalEnabled"
  | "knowledgeRerankEnabled" | "knowledgeRerankProvider" | "knowledgeRerankModel"
  | "knowledgeContextNeighbors"
>;

/** Снимок настроек из живой конфигурации: панель меняет её без перезапуска. */
export function knowledgeSearchSettings(config: KnowledgeSearchConfig): KnowledgeSearchSettings {
  const provider = config.knowledgeRerankProvider.trim();
  const model = config.knowledgeRerankModel.trim();
  return {
    enabled: config.knowledgeSearchEnabled,
    mode: parseKnowledgeSearchMode(config.knowledgeSearchMode, "legacy"),
    vectorBackend: parseKnowledgeVectorBackend(config.knowledgeVectorBackend, "pgvector"),
    shadow: config.knowledgeSearchShadow,
    privateEnabled: config.knowledgePrivateEnabled,
    globalEnabled: config.knowledgeGlobalEnabled,
    // Включённый reranker без провайдера или модели — выключенный: поиск
    // не должен падать из-за незаполненного поля.
    rerank: config.knowledgeRerankEnabled && provider && model ? { providerId: provider, model } : null,
    neighbors: Math.min(Math.max(Math.trunc(config.knowledgeContextNeighbors) || 0, 0), 2),
  };
}

/** Прежнее поведение — для вызывающих без конфигурации (тесты, сборка без панели). */
export const LEGACY_SEARCH_SETTINGS: Readonly<KnowledgeSearchSettings> = Object.freeze({
  enabled: true,
  mode: "legacy",
  vectorBackend: "pgvector",
  shadow: false,
  privateEnabled: true,
  globalEnabled: true,
  rerank: null,
  neighbors: 1,
});
