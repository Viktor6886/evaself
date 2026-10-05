/**
 * Настройки поиска по базе знаний: панель переключает их без перезапуска,
 * умолчания повторяют прежнее поведение, а незаполненный reranker не
 * роняет поиск.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyManagedRuntimeConfig, importEnvironmentKnowledgeSettings, readKnowledgeUploadsSetting } from "../dist/admin/managed-runtime-config.js";
import { KNOWLEDGE_SETTINGS } from "../dist/admin/settings-registry.js";
import { loadConfig } from "../dist/config.js";
import { knowledgeSearchSettings } from "../dist/knowledge/search-settings.js";

const SEARCH_KEYS = [
  "runtime.knowledge_search_enabled", "runtime.knowledge_search_mode", "runtime.knowledge_vector_backend",
  "runtime.knowledge_search_shadow", "runtime.knowledge_private_enabled", "runtime.knowledge_global_enabled",
  "runtime.knowledge_rerank_enabled", "runtime.knowledge_rerank_provider", "runtime.knowledge_rerank_model",
  "runtime.knowledge_context_neighbors",
];

test("умолчания — прежний поиск: legacy, pgvector, без тени и reranker", () => {
  const config = loadConfig({});
  assert.deepEqual(knowledgeSearchSettings(config), {
    enabled: true, mode: "legacy", vectorBackend: "pgvector", shadow: false,
    privateEnabled: true, globalEnabled: true, rerank: null, neighbors: 1,
  });
  // Умолчание панели совпадает с умолчанием окружения: иначе первое
  // сохранение любой настройки переключило бы поиск молча.
  const byEnv = new Map(KNOWLEDGE_SETTINGS.map((item) => [item.env, item]));
  for (const key of SEARCH_KEYS) {
    const definition = KNOWLEDGE_SETTINGS.find((item) => item.key === key);
    assert.ok(definition, `${key} нет в реестре`);
    assert.equal(definition.requires_restart, false, `${key} требует перезапуска`);
    assert.equal(definition.group, "knowledge");
    assert.ok(byEnv.has(definition.env));
  }
  const mode = KNOWLEDGE_SETTINGS.find((item) => item.key === "runtime.knowledge_search_mode")!;
  assert.deepEqual(mode.presets?.map((preset) => preset.value), ["legacy", "hybrid", "vector", "lexical"]);
  assert.equal(mode.default, "legacy");
});

test("загрузка: каноническая настройка включает приём без перезапуска, переживает старт и откатывается к окружению", async () => {
  const key = "runtime.knowledge_uploads_enabled";
  const definition = KNOWLEDGE_SETTINGS.find((s) => s.key === key)!;
  assert.equal(definition.env, "EVA_KNOWLEDGE_UPLOADS");
  assert.equal(definition.default, false);
  assert.equal(definition.requires_restart, false);
  let rows: Array<{ key: string; value_json: unknown }> = [];
  const db = { query: async () => ({ rows }) };
  const config = loadConfig({ EVA_KNOWLEDGE_UPLOADS: "false" });
  await applyManagedRuntimeConfig(config, db as never);
  assert.equal(config.knowledgeUploadsEnabled, false);
  assert.equal(await readKnowledgeUploadsSetting(db as never, false), false);
  rows = [{ key, value_json: true }];
  await applyManagedRuntimeConfig(config, db as never);
  assert.equal(config.knowledgeUploadsEnabled, true);
  assert.equal(await readKnowledgeUploadsSetting(db as never, false), true);
  const restarted = loadConfig({ EVA_KNOWLEDGE_UPLOADS: "false" });
  await applyManagedRuntimeConfig(restarted, db as never);
  assert.equal(restarted.knowledgeUploadsEnabled, true, "настройка потерялась после старта процесса");
  rows = [{ key, value_json: false }];
  await applyManagedRuntimeConfig(config, db as never);
  assert.equal(config.knowledgeUploadsEnabled, false);
  assert.equal(await readKnowledgeUploadsSetting(db as never, true), false, "окружение перебило сохранённое false");
  rows = [];
  await applyManagedRuntimeConfig(config, db as never);
  assert.equal(config.knowledgeUploadsEnabled, false);
  assert.equal(await readKnowledgeUploadsSetting(db as never, true), true);
  rows = [{ key, value_json: "true" }];
  assert.equal(await readKnowledgeUploadsSetting(db as never, false), false, "строка ошибочно включила приём");
  const inserted: unknown[][] = [];
  await importEnvironmentKnowledgeSettings(loadConfig({ EVA_KNOWLEDGE_UPLOADS: "true" }), { query: async (sql: string, values: unknown[]) => {
    if (sql.includes("INSERT INTO system_settings")) inserted.push(values);
    return { rows: [], rowCount: 1 };
  } } as never);
  assert.deepEqual(inserted, [[key, "true"]]);
});

test("окружение: неизвестный режим — legacy, соседей не больше двух", () => {
  const config = loadConfig({
    EVA_KNOWLEDGE_SEARCH_MODE: "turbo",
    EVA_KNOWLEDGE_VECTOR_BACKEND: "elastic",
    EVA_KNOWLEDGE_CONTEXT_NEIGHBORS: "9",
  });
  assert.equal(config.knowledgeSearchMode, "legacy");
  assert.equal(config.knowledgeVectorBackend, "pgvector");
  assert.equal(config.knowledgeContextNeighbors, 2);
});

test("reranker включается только с провайдером и моделью", () => {
  const base = loadConfig({});
  assert.equal(knowledgeSearchSettings({ ...base, knowledgeRerankEnabled: true }).rerank, null);
  assert.equal(knowledgeSearchSettings({ ...base, knowledgeRerankEnabled: true, knowledgeRerankProvider: "jina" }).rerank, null);
  assert.deepEqual(
    knowledgeSearchSettings({ ...base, knowledgeRerankEnabled: true, knowledgeRerankProvider: " jina ", knowledgeRerankModel: "m " }).rerank,
    { providerId: "jina", model: "m" },
  );
  assert.equal(knowledgeSearchSettings({ ...base, knowledgeRerankProvider: "jina", knowledgeRerankModel: "m" }).rerank, null);
});

test("панель переключает поиск без перезапуска; без строки — значение окружения", async () => {
  const config = loadConfig({ EVA_KNOWLEDGE_RERANK_PROVIDER: "env-provider" });
  let rows: Array<{ key: string; value_json: unknown }> = [
    { key: "runtime.knowledge_search_mode", value_json: "hybrid" },
    { key: "runtime.knowledge_vector_backend", value_json: "qdrant" },
    { key: "runtime.knowledge_search_shadow", value_json: true },
    { key: "runtime.knowledge_global_enabled", value_json: false },
    { key: "runtime.knowledge_rerank_enabled", value_json: true },
    { key: "runtime.knowledge_rerank_provider", value_json: "jina" },
    { key: "runtime.knowledge_rerank_model", value_json: "jina-reranker" },
    { key: "runtime.knowledge_context_neighbors", value_json: 2 },
  ];
  const db = { query: async () => ({ rows }) };
  const changed = await applyManagedRuntimeConfig(config, db as never);
  assert.deepEqual(knowledgeSearchSettings(config), {
    enabled: true, mode: "hybrid", vectorBackend: "qdrant", shadow: true,
    privateEnabled: true, globalEnabled: false, rerank: { providerId: "jina", model: "jina-reranker" }, neighbors: 2,
  });
  assert.ok(changed.includes("runtime.knowledge_search_mode"));

  // Мусорное значение в строке не ломает поиск: остаётся действующее, как
  // у остальных настроек панели; соседей не больше двух.
  rows = [{ key: "runtime.knowledge_search_mode", value_json: "turbo" }, { key: "runtime.knowledge_context_neighbors", value_json: 99 }];
  await applyManagedRuntimeConfig(config, db as never);
  assert.equal(config.knowledgeSearchMode, "hybrid");
  assert.equal(config.knowledgeContextNeighbors, 2);

  rows = [];
  await applyManagedRuntimeConfig(config, db as never);
  assert.equal(config.knowledgeSearchMode, "legacy");
  assert.equal(config.knowledgeVectorBackend, "pgvector");
  assert.equal(config.knowledgeSearchShadow, false);
  assert.equal(config.knowledgeGlobalEnabled, true);
  assert.equal(config.knowledgeRerankProvider, "env-provider");
  assert.equal(config.knowledgeContextNeighbors, 1);
});

test("установка с поиском в окружении не выглядит в панели прежней", async () => {
  const config = loadConfig({ EVA_KNOWLEDGE_SEARCH_MODE: "hybrid", EVA_KNOWLEDGE_SEARCH: "false" });
  const inserted: unknown[][] = [];
  const db = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes("INSERT INTO system_settings")) inserted.push(values);
      return { rows: [], rowCount: 1 };
    },
  };
  const imported = await importEnvironmentKnowledgeSettings(config, db as never);
  assert.deepEqual(imported.sort(), ["runtime.knowledge_search_enabled", "runtime.knowledge_search_mode"]);
  assert.deepEqual(inserted, [["runtime.knowledge_search_enabled", "false"], ["runtime.knowledge_search_mode", "\"hybrid\""]]);
});
