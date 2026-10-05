/**
 * Административные операции индекса, выделенные из прежнего сервиса
 * документов, чтобы K7 не раздувал его. Те же маршруты, pool, Qdrant и
 * job/outbox; собственного хранилища или конвейера здесь нет.
 */
import type pg from "pg";

import { recordJobIntent, type JobOutboxClient } from "../jobs/job-outbox.js";
import { scheduleKnowledgeReconcile, startKnowledgeRebuild } from "../knowledge/maintenance.js";
import { QdrantError, type QdrantDistance } from "../knowledge/qdrant-client.js";
import { KnowledgeVersionError, validateKnowledgeVersion } from "../knowledge/version-validation.js";
import type { KnowledgeDocumentsOptions } from "./knowledge-documents-service.js";
import { adminBadRequest, adminConflict, adminNotFound } from "./errors.js";

const outbox = { record: recordJobIntent };
function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : value ? String(value) : null;
}
function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

export class KnowledgeIndexService {
  constructor(private readonly pool: Pick<pg.Pool, "query" | "connect">, private readonly options: KnowledgeDocumentsOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Состояние индекса: документы по состоянию, отставание, версии с
   * прогрессом построения. Личные базы — только счётчиками.
   */
  async indexOverview(): Promise<Record<string, unknown>> {
    const { rows } = await this.pool.query<Record<string, unknown>>(
      `SELECT CASE WHEN user_id IS NULL THEN 'global' ELSE 'private' END AS scope,
              index_status,
              count(*) AS documents,
              COALESCE(sum(chunk_count), 0) AS chunks,
              COALESCE(EXTRACT(EPOCH FROM now() - min(updated_at)
                FILTER (WHERE index_status IN ('pending', 'indexing'))), 0) AS lag_seconds
         FROM knowledge_documents
         -- tenant: system — счётчики по всем базам; ни названий, ни владельцев наружу
        WHERE status = 'ready' AND (user_id IS NOT NULL OR (product_verified AND collection_id IS NOT NULL))
        GROUP BY 1, 2`,
    );
    const empty = () => ({ documents: 0, chunks: 0, lag_seconds: 0, by_status: {} as Record<string, number> });
    const scopes = { private: empty(), global: empty() };
    for (const row of rows) {
      const scope = scopes[row.scope === "global" ? "global" : "private"];
      const documents = Number(row.documents);
      scope.documents += documents;
      scope.chunks += Number(row.chunks);
      scope.lag_seconds = Math.max(scope.lag_seconds, Math.round(Number(row.lag_seconds)));
      scope.by_status[String(row.index_status)] = documents;
    }
    // Сколько людей ведут личную базу — число, без их идентификаторов.
    const owners = await this.pool.query<{ total: string }>(
      `SELECT count(DISTINCT user_id) AS total FROM knowledge_documents
        -- tenant: system — число людей с личной базой, без идентификаторов
        WHERE user_id IS NOT NULL`,
    );

    const versions = await this.pool.query<Record<string, unknown>>(
      `SELECT version, model, dimension, status, error_code, build_started_at, built_at, activated_at
         FROM knowledge_embedding_versions
        WHERE status IN ('draft', 'building', 'ready', 'active', 'retired', 'failed')
        ORDER BY version DESC`,
    );
    const totalChunks = scopes.private.chunks + scopes.global.chunks;
    const store = this.options.store;
    const healthy = store ? await store.ready() : false;
    let aliases: { private: number | null; global: number | null } | null = null;
    if (store && healthy) aliases = await store.activeVersions().catch(() => null);
    const active = versions.rows.find((row) => row.status === "active");
    const viewed = [];
    for (const row of versions.rows) {
      const version = Number(row.version);
      let points: number | null = null;
      if (store && healthy && !["draft", "failed"].includes(String(row.status))) {
        try {
          points = (await store.countPoints("private", version)) + (await store.countPoints("global", version));
        } catch {
          // Qdrant недоступен или коллекций нет — прогресс неизвестен, а не ноль.
          points = null;
        }
      }
      const started = row.build_started_at instanceof Date ? row.build_started_at.getTime() : null;
      const built = row.built_at instanceof Date ? row.built_at.getTime() : null;
      viewed.push({
        version,
        model: String(row.model),
        dimension: Number(row.dimension),
        status: String(row.status),
        error_code: row.error_code ? String(row.error_code) : null,
        building: started !== null && (built === null || started > built) && row.status !== "failed" && !row.error_code,
        build_started_at: iso(row.build_started_at),
        built_at: iso(row.built_at),
        activated_at: iso(row.activated_at),
        points,
        progress: points === null ? null : totalChunks > 0 ? Math.min(points / totalChunks, 1) : 1,
      });
    }
    return {
      qdrant: store !== null,
      qdrant_status: !store ? "not_configured" : healthy ? "ready" : "unavailable",
      aliases,
      aliases_match_active: aliases ? aliases.private === (active ? Number(active.version) : null)
        && aliases.global === (active ? Number(active.version) : null) : null,
      uploads_enabled: this.options.uploadsEnabled,
      private_owners: Number(owners.rows[0]?.total ?? 0),
      scopes,
      versions: viewed,
    };
  }

  /** Построить версию (первый раз) или перестроить; `full` — переписать и полные документы. */
  async build(version: unknown, body: unknown): Promise<{ version: number; status: string; started_at: string }> {
    const number = Number(version);
    if (!Number.isInteger(number) || number <= 0) throw adminBadRequest("Номер версии задан неверно", { field: "version" });
    if (!this.options.store) throw adminConflict("QDRANT_API_KEY не задан: индексу негде жить");
    const full = record(body).full === true;
    const started = await this.transaction(async (client) => await startKnowledgeRebuild(outbox, client as unknown as JobOutboxClient, number, full));
    if (!started) throw adminConflict("Построить можно черновик, неудавшуюся, готовую, активную или выведенную версию");
    return { version: number, status: started.status, started_at: new Date(started.started).toISOString() };
  }


  /**
   * K7: полная проверка → оба alias атомарно → retired/active одним
   * COMMIT. Поиск называет физическую версию из PostgreSQL, поэтому
   * переход и любой частичный отказ не смешивают векторные пространства.
   * Выведенная версия пригодна для отката только после той же проверки;
   * если после вывода появились документы, её сначала нужно перестроить.
   */
  async activate(version: unknown, body?: unknown): Promise<{ version: number; status: string }> {
    const number = Number(version);
    if (!Number.isInteger(number) || number <= 0) throw adminBadRequest("Номер версии задан неверно", { field: "version" });
    const store = this.options.store;
    if (!store) throw adminConflict("QDRANT_API_KEY не задан: индексу негде жить");
    let aliasesAttempted = false;
    try {
      return await this.transaction(async (client) => {
        await this.activationLock(client);
        const { rows } = await client.query<{
          version: number; model: string; dimension: number; distance: QdrantDistance; status: string;
          built_at: Date | null; build_started_at: Date | null; error_code: string | null;
        }>(
          `SELECT version, model, dimension, distance, status, built_at, build_started_at, error_code
             FROM knowledge_embedding_versions
            WHERE version = $1 OR status = 'active'
            ORDER BY version FOR UPDATE`,
          [number],
        );
        const target = rows.find((row) => Number(row.version) === number);
        if (!target) throw adminNotFound("Версия эмбеддингов не найдена");
        const input = record(body);
        const current = rows.find((row) => row.status === "active");
        if (input.verify_only === true && target.status !== "active") {
          throw adminConflict("Активная модель изменилась. Обновите страницу перед включением поиска.");
        }
        if (Object.hasOwn(input, "expected_active_version") && input.expected_active_version !== (current ? Number(current.version) : null)) {
          throw adminConflict("Активная версия изменилась другим администратором. Обновите страницу.");
        }
        const building = target.build_started_at && (!target.built_at || target.build_started_at > target.built_at);
        if (!["ready", "retired", "active"].includes(target.status) || !target.built_at || building || target.error_code) {
          throw adminConflict("Активировать можно только полностью построенную версию без ошибок. Дождитесь построения.", { status: target.status });
        }
        await validateKnowledgeVersion(client, store, {
          version: number, model: target.model, dimension: Number(target.dimension), distance: target.distance,
        });
        aliasesAttempted = true; // timeout мог случиться уже после применения запроса
        await store.activate(number);
        if (target.status !== "active") {
          // Частичный уникальный индекс активной версии сохраняется:
          // прежняя выводится раньше новой, но обе записи — один COMMIT.
          await client.query(
            "UPDATE knowledge_embedding_versions SET status = 'retired', retired_at = now() WHERE status = 'active' AND version <> $1",
            [number],
          );
          const updated = await client.query(
            `UPDATE knowledge_embedding_versions SET status = 'active', activated_at = now(), retired_at = NULL
              WHERE version = $1 AND status IN ('ready', 'retired') RETURNING version`,
            [number],
          );
          if (!updated.rows[0]) throw adminConflict("Версию успели изменить: обновите страницу");
        }
        return { version: number, status: "active" };
      });
    } catch (error) {
      if (aliasesAttempted) {
        // Между Qdrant и PostgreSQL нет распределённой транзакции. После
        // ROLLBACK (включая неоднозначный COMMIT) заново сериализуемся и
        // восстанавливаем alias по ФАКТИЧЕСКОЙ канонической версии.
        // Смерть процесса лечится повтором activate текущей версии; это
        // расхождение показывается в overview, поиск всегда версионный.
        let canonical: number | null;
        try {
          canonical = await this.transaction(async (client) => {
            await this.activationLock(client);
            const active = await client.query<{ version: number }>(
              "SELECT version FROM knowledge_embedding_versions WHERE status = 'active' FOR UPDATE",
            );
            const current = active.rows[0] ? Number(active.rows[0].version) : null;
            await store.activate(current);
            return current;
          });
        } catch {
          throw adminConflict("Переключение не завершено, aliases требуют восстановления. Повторите активацию текущей версии после восстановления Qdrant. Поиск использует версию из PostgreSQL.", { code: "knowledge_alias_recovery_required" });
        }
        // COMMIT применился, а соединение оборвалось до ответа.
        if (canonical === number) return { version: number, status: "active" };
      }
      if (error instanceof KnowledgeVersionError) throw adminConflict(error.message, { code: error.code });
      if (error && typeof error === "object" && "code" in error && error.code === "55P03") {
        throw adminConflict("Индекс или документы сейчас изменяются. Дождитесь завершения записи и повторите активацию.", { code: "knowledge_activation_busy" });
      }
      if (error instanceof QdrantError) throw adminConflict("Qdrant недоступен: версия не переключена, поиск продолжает работать с lexical fallback.", { code: error.code });
      throw error;
    }
  }

  private async activationLock(client: Pick<pg.PoolClient, "query">): Promise<void> {
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('knowledge.embedding.activation'))");
  }
  /** Сверка PostgreSQL ↔ Qdrant сейчас, не дожидаясь расписания. */
  async reconcile(): Promise<{ scheduled: true }> {
    await this.transaction(async (client) => await scheduleKnowledgeReconcile(outbox, client as unknown as JobOutboxClient, this.now()));
    return { scheduled: true };
  }
}
