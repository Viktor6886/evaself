/**
 * Ответы API раздела «База знаний» для браузерных тестов панели: общие
 * для страницы документов и для «Поиска по смыслу»; в конце — помощники
 * тестов «Поиска по смыслу».
 */

export const COLLECTION = { id: "1c000000-0000-4000-8000-000000000001", code: "faq", title: "FAQ", description: "Частые вопросы",
  enabled: true, position: 0, documents: 2, indexed: 1, failed: 1, chunks: 12, created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z" };
export const DOCS = [
  { id: "0a000000-0000-4000-8000-00000000000a", collection_id: COLLECTION.id, name: "Регламент.pdf", mime: "application/pdf",
    size_bytes: 204800, chunk_count: 8, status: "ready", index_status: "ready", index_error: null, revision: 2,
    created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T11:00:00Z" },
  { id: "0b000000-0000-4000-8000-00000000000b", collection_id: COLLECTION.id, name: "FAQ.md", mime: "text/markdown",
    size_bytes: 2048, chunk_count: 4, status: "ready", index_status: "failed", index_error: "qdrant_unavailable", revision: 1,
    created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:05:00Z" },
];
export const UPLOADS = [
  { id: "0c000000-0000-4000-8000-00000000000c", collection_id: COLLECTION.id, name: "Копия.pdf", mime: "application/pdf",
    size_bytes: 204800, status: "ready", outcome: "duplicate", error_code: null, created_at: "2026-09-30T11:00:00Z" },
  { id: "0d000000-0000-4000-8000-00000000000d", collection_id: COLLECTION.id, name: "Битый.pdf", mime: "application/pdf",
    size_bytes: 10, status: "failed", outcome: null, error_code: "document_empty", created_at: "2026-09-30T11:05:00Z" },
];
export const INDEX = {
  qdrant: true,
  qdrant_status: "ready", aliases: { private: null, global: null }, aliases_match_active: true, uploads_enabled: true,
  private_owners: 3,
  scopes: {
    private: { documents: 7, chunks: 70, lag_seconds: 0, by_status: { ready: 7 } },
    global: { documents: 2, chunks: 12, lag_seconds: 0, by_status: { ready: 1, failed: 1 } },
  },
  versions: [{ version: 2, model: "bge-m3", dimension: 1024, status: "ready", error_code: null, building: false,
    build_started_at: "2026-09-30T09:00:00Z", built_at: "2026-09-30T09:10:00Z", activated_at: null, points: 82, progress: 1 }],
};

export const PROVIDERS = [{ id: "p1", name: "OpenRouter", chat_model: "openai/gpt-5" }, { id: "p2", name: "Jina", chat_model: "jina-chat" }];
export const VERSION = { ...INDEX.versions[0], provider_id: "p1", provider_name: "OpenRouter", request_dimensions: false,
  distance: "Cosine", hnsw_m: 16, hnsw_ef_construct: 100, on_disk: false, fallback_provider_id: null, fallback_model: null };
export const EMBEDDINGS = { providers: PROVIDERS, versions: [VERSION], active: null };
export const RECOMMENDED = {
  "runtime.knowledge_index_enabled": true, "runtime.knowledge_search_enabled": true,
  "runtime.knowledge_search_mode": "hybrid", "runtime.knowledge_vector_backend": "qdrant",
  "runtime.knowledge_private_enabled": true, "runtime.knowledge_global_enabled": true,
};
export const UPLOAD_SETTING = { key: "runtime.knowledge_uploads_enabled", title: "База знаний: загрузка файлов", value: true };
export const SETTINGS = { etag: '"kb-1"', settings: [UPLOAD_SETTING, ...Object.entries(RECOMMENDED).map(([key, value]) => ({ key, title: key,
  value: key.endsWith("search_mode") ? "legacy" : key.endsWith("vector_backend") ? "pgvector" : value,
  presets: typeof value === "boolean" ? undefined : (key.endsWith("search_mode") ? ["legacy", "hybrid", "vector", "lexical"] : ["pgvector", "qdrant"]).map((v) => ({ value: v, title: v })),
}))] };
export const ACTIVE = { ...VERSION, status: "active", activated_at: "2026-09-30T10:00:00Z" };
export const ACTIVE_ROUTES = {
  "/knowledge/embeddings": { ...EMBEDDINGS, active: 2, versions: [ACTIVE] },
  "/knowledge/index": { ...INDEX, aliases: { private: 2, global: 2 }, versions: [ACTIVE] },
};

export const ROUTES = {
  "/knowledge/collections": { collections: [COLLECTION] },
  "/knowledge/documents": { documents: DOCS, total: 2 },
  "/knowledge/uploads": { uploads: UPLOADS },
  "/knowledge/index": INDEX,
  "/knowledge/embeddings": EMBEDDINGS,
  "/settings": SETTINGS,
};

// «Поиск по смыслу»: вход в раздел, форма модели, состояние шагов.

export async function enterKnowledge(panel) {
  await panel.page.click('[data-page="knowledge"]');
  // Шаги стоят в разметке; состояние у них появляется после загрузки.
  await panel.page.waitForSelector("#knowledge-setup [data-state], #knowledge-setup .warn-value");
}

/** Форма модели открыта при первой настройке, потом — по «Сменить модель». */
export async function openModelForm(panel) {
  if (await panel.page.locator("#knowledge-embedding-form").count() === 0) await panel.page.click("#knowledge-setup-change");
  await panel.page.waitForSelector("#knowledge-embedding-form");
}

export const stepState = async (panel, n) => await panel.page.getAttribute(`[data-setup-step="${n}"]`, "data-state");
export const toastText = async (panel) => await panel.page.textContent("#toast");
export const EMPTY_ROUTES = { "/knowledge/embeddings": { ...EMBEDDINGS, versions: [] }, "/knowledge/index": { ...INDEX, versions: [] } };
export const LIVE_SETTINGS = { ...SETTINGS, settings: SETTINGS.settings.map((s) => ({ ...s, value: RECOMMENDED[s.key] ?? s.value })) };
export const INDEX_OFF = { ...SETTINGS, settings: SETTINGS.settings.map((s) => s.key === "runtime.knowledge_index_enabled" ? { ...s, value: false } : s) };
export const DRAFT = { ...VERSION, version: 1, model: "openai/text-embedding-3-large", dimension: 3072, status: "draft",
  building: false, build_started_at: null, built_at: null, activated_at: null, points: null, progress: null };
