/**
 * Шаблоны memory block: предпросмотр, массовое применение, откат.
 *
 * Что здесь НЕ заводится. Своей системы версий шаблонов нет: шаблон — это
 * артефакт вида `memory_block_template` в общем реестре (шаг 13), и версии,
 * утверждение, публикация и diff берутся оттуда. Своего пути записи в Letta
 * тоже нет: применение кладёт намерение в `letta_memory_block_sync` через
 * существующий `MemoryBlockSync`, откуда его забирает та же синхронизация,
 * что и для точечной правки блока. Второй писатель блоков означал бы, что
 * «записано» начинает значить разное в разных местах.
 *
 * Разделение, ради которого всё это существует:
 *
 *   публикация версии шаблона  → действует на НОВЫХ агентов;
 *   применение версии шаблона  → действует на СУЩЕСТВУЮЩИХ, и только по
 *                                отдельной команде с подтверждением.
 *
 * Иначе правка шаблона незаметно переписывала бы персону у всех живых
 * агентов — необратимо, потому что прежних значений Letta не хранит.
 *
 * Откат устроен указателем, а не хранением прежних значений: он применяет
 * родительскую версию шаблона к тому же набору агентов и записывается
 * новым прогоном. Поэтому в журнале применений нет ни одной строки памяти —
 * только отпечатки.
 */

import { badRequest, notFound } from "../errors.js";
import type { ArtifactRegistry } from "../artifacts/registry.js";
import {
  blockChecksum,
  type MemoryBlockSync,
  type SyncedBlockLabel,
  SYNCED_BLOCK_LABELS,
} from "../letta/memory-block-sync.js";

export type ApplicationScope = "agent" | "group" | "all";

export type ItemOutcome = "excluded" | "unchanged" | "recorded" | "skipped" | "failed";

export interface TemplateItem {
  agentId: string;
  userId: number;
  label: SyncedBlockLabel;
  previousChecksum: string | null;
  nextChecksum: string;
  outcome: ItemOutcome;
  detail: string;
}

export interface TemplateApplication {
  id: number;
  artifactId: number;
  versionId: number;
  version: number;
  scope: ApplicationScope;
  targets: string[];
  excluded: string[];
  dryRun: boolean;
  status: "previewed" | "applied" | "failed";
  counts: Record<string, number>;
  revertsId: number | null;
  reason: string;
  createdAt: string;
  items: TemplateItem[];
}

export interface TemplateInput {
  versionId: number;
  scope: ApplicationScope;
  agentIds?: string[];
  excluded?: string[];
  reason?: string;
  actorId?: string | null;
}

export interface TemplateDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Сколько агентов одно применение трогает за раз. Выше — уже не операция. */
const MAX_TARGETS = 2000;

interface TargetAgent {
  agentId: string;
  userId: number;
  status: string;
}

export class MemoryTemplateService {
  constructor(
    private readonly db: TemplateDatabase,
    private readonly registry: ArtifactRegistry,
    private readonly sync: MemoryBlockSync,
  ) {}

  /**
   * Что изменится, если применить версию шаблона прямо сейчас.
   *
   * Предпросмотр обязателен до применения и сам остаётся в истории:
   * «что предлагали и не сделали» — такой же факт, как «что сделали».
   */
  async preview(input: TemplateInput): Promise<TemplateApplication> {
    return await this.run(input, true);
  }

  /** Применить версию шаблона. Подтверждение проверяет маршрут. */
  async apply(input: TemplateInput): Promise<TemplateApplication> {
    return await this.run(input, false);
  }

  /**
   * Откат одним действием.
   *
   * Возвращает родительскую версию шаблона тем агентам, которым это
   * применение действительно что-то записало. История не переписывается:
   * откат — ещё один прогон со ссылкой на откатываемый.
   */
  async rollback(
    applicationId: number,
    reason: string,
    actorId: string | null,
  ): Promise<TemplateApplication> {
    if (!reason.trim()) {
      // Причина отката теряется первой, а спрашивают о ней всегда.
      throw badRequest("Откат требует причины");
    }
    const source = await this.application(applicationId);
    if (source.dryRun || source.status !== "applied") {
      throw badRequest("Откатывается только выполненное применение, а не предпросмотр");
    }
    const version = await this.registry.version(source.versionId);
    if (version.parentId === null) {
      throw badRequest("Это первая версия шаблона: откатывать не на что");
    }
    const agents = [...new Set(
      source.items.filter((item) => item.outcome === "recorded").map((item) => item.agentId),
    )];
    if (agents.length === 0) {
      throw badRequest("Применение ничего не записало: откатывать нечего");
    }
    return await this.run({
      versionId: version.parentId,
      scope: agents.length === 1 ? "agent" : "group",
      agentIds: agents,
      reason,
      actorId,
    }, false, applicationId);
  }

  /** История применений. Без построчных исходов: они читаются по одному. */
  async history(limit = 50): Promise<Omit<TemplateApplication, "items">[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const { rows } = await this.db.query(
      `SELECT a.id, a.artifact_id, a.version_id, v.version, a.scope, a.targets, a.excluded,
              a.dry_run, a.status, a.counts, a.reverts_id, a.reason, a.created_at
         FROM memory_template_applications a
         JOIN artifact_versions v ON v.id = a.version_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $1`,
      [bounded],
    );
    return rows.map(toApplication);
  }

  async application(id: number): Promise<TemplateApplication> {
    const { rows } = await this.db.query(
      `SELECT a.id, a.artifact_id, a.version_id, v.version, a.scope, a.targets, a.excluded,
              a.dry_run, a.status, a.counts, a.reverts_id, a.reason, a.created_at
         FROM memory_template_applications a
         JOIN artifact_versions v ON v.id = a.version_id
        WHERE a.id = $1`,
      [id],
    );
    if (rows.length === 0) throw notFound(`применение шаблона ${id} не найдено`);
    const { rows: items } = await this.db.query(
      `-- tenant: system — построчный исход общесистемного применения шаблона; область администратора объявлена маршрутом и записана в аудит
       SELECT agent_id, user_id, label, previous_checksum, next_checksum, outcome, detail
         FROM memory_template_application_items
        WHERE application_id = $1
        ORDER BY agent_id, label`,
      [id],
    );
    return { ...toApplication(rows[0]!), items: items.map(toItem) };
  }

  /**
   * Шаблон новых агентов: что действует в окружении прямо сейчас.
   *
   * Читается, но не применяется: публикация другой версии меняет то, с чем
   * создаются новые агенты, и существующих не касается вовсе.
   */
  async newAgentTemplates(environment: string): Promise<Array<{
    artifactId: number;
    slug: string;
    title: string;
    versionId: number | null;
    version: number | null;
    publishedAt: string | null;
  }>> {
    const artifacts = await this.registry.list("memory_block_template");
    const result = [];
    for (const artifact of artifacts) {
      const active = await this.registry.active(artifact.id, environment);
      result.push({
        artifactId: artifact.id,
        slug: artifact.slug,
        title: artifact.title,
        versionId: active?.versionId ?? null,
        version: active?.version ?? null,
        publishedAt: active?.publishedAt ?? null,
      });
    }
    return result;
  }

  private async run(
    input: TemplateInput,
    dryRun: boolean,
    revertsId: number | null = null,
  ): Promise<TemplateApplication> {
    const version = await this.registry.version(input.versionId);
    const artifact = (await this.registry.list("memory_block_template"))
      .find((row) => row.id === version.artifactId);
    if (!artifact) {
      throw badRequest("Версия принадлежит артефакту, который не является шаблоном memory block");
    }
    // Применяется только утверждённая версия: `candidate` — это
    // «предложено», а не «решено», и памяти живых агентов оно не касается.
    if (!dryRun && version.status !== "approved") {
      throw badRequest(
        `Версия ${version.version} в состоянии ${version.status}: применяется только утверждённая`,
      );
    }

    const blocks = templateBlocks(version.body);
    const excluded = new Set(normalizeIds(input.excluded ?? []));
    const targets = normalizeIds(input.agentIds ?? []);
    if (input.scope !== "all" && targets.length === 0) {
      throw badRequest("Для области agent и group нужен хотя бы один агент");
    }
    if (input.scope === "agent" && targets.length !== 1) {
      throw badRequest("Область agent — это ровно один агент");
    }

    const agents = await this.resolveAgents(input.scope, targets);
    if (agents.length > MAX_TARGETS) {
      throw badRequest(
        `Под выборку попало ${agents.length} агентов при пределе ${MAX_TARGETS}: сузьте область`,
      );
    }
    const current = await this.currentChecksums(agents.map((agent) => agent.agentId));

    const items: TemplateItem[] = [];
    for (const agent of agents) {
      for (const block of blocks) {
        const nextChecksum = blockChecksum(block.value);
        const previousChecksum = current.get(`${agent.agentId}|${block.label}`) ?? null;
        const base = {
          agentId: agent.agentId,
          userId: agent.userId,
          label: block.label,
          previousChecksum,
          nextChecksum,
        };
        if (excluded.has(agent.agentId)) {
          items.push({ ...base, outcome: "excluded", detail: "агент исключён человеком" });
          continue;
        }
        if (agent.status !== "active") {
          items.push({ ...base, outcome: "skipped", detail: `агент в состоянии ${agent.status}` });
          continue;
        }
        if (previousChecksum === nextChecksum) {
          items.push({ ...base, outcome: "unchanged", detail: "значение уже такое же" });
          continue;
        }
        items.push({
          ...base,
          outcome: "recorded",
          detail: dryRun ? "будет записано намерение" : "намерение записано",
        });
      }
    }

    if (!dryRun) {
      for (const item of items) {
        if (item.outcome !== "recorded") continue;
        const block = blocks.find((entry) => entry.label === item.label)!;
        try {
          await this.sync.record(item.userId, item.agentId, item.label, block.value);
        } catch (error) {
          // Отказ по одному агенту не отменяет остальных: прогон честно
          // показывает, кому записалось, а кому нет.
          item.outcome = "failed";
          item.detail = error instanceof Error ? error.name : "unknown_error";
        }
      }
    }

    return await this.persist({
      artifactId: artifact.id,
      versionId: version.id,
      version: version.version,
      scope: input.scope,
      targets: input.scope === "all" ? [] : targets,
      excluded: [...excluded],
      dryRun,
      revertsId,
      reason: input.reason ?? "",
      actorId: input.actorId ?? null,
      items,
    });
  }

  private async resolveAgents(scope: ApplicationScope, targets: string[]): Promise<TargetAgent[]> {
    const { rows } = await this.db.query(
      `-- tenant: system — массовое применение шаблона идёт по агентам всей установки; ограничение по одному владельцу здесь невозможно, область администратора объявлена маршрутом и записана в аудит
       SELECT agent_id, user_id, status
         FROM agent_links
        WHERE kind = 'eva'
          AND ($1::boolean OR agent_id = ANY($2::text[]))
        ORDER BY agent_id`,
      [scope === "all", targets],
    );
    const agents = rows.map((row) => ({
      agentId: String(row.agent_id ?? ""),
      userId: Number(row.user_id ?? 0),
      status: String(row.status ?? "active"),
    })).filter((agent) => agent.agentId && agent.userId > 0);

    if (scope !== "all") {
      const known = new Set(agents.map((agent) => agent.agentId));
      const unknown = targets.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw badRequest(`Агенты не найдены: ${unknown.slice(0, 5).join(", ")}`);
      }
    }
    return agents;
  }

  /**
   * Отпечатки действующих намерений.
   *
   * Считаются в PostgreSQL, а не здесь: сравнивать нужно отпечатки, и
   * вытаскивать ради этого тексты чужой памяти в память админ-процесса
   * незачем.
   */
  private async currentChecksums(agentIds: string[]): Promise<Map<string, string>> {
    if (agentIds.length === 0) return new Map();
    const { rows } = await this.db.query(
      `-- tenant: system — сверка отпечатков по набору агентов установки; область администратора объявлена маршрутом и записана в аудит
       SELECT agent_id, label,
              left(encode(sha256(convert_to(desired_value, 'UTF8')), 'hex'), 16) AS checksum
         FROM letta_memory_block_sync
        WHERE agent_id = ANY($1::text[])`,
      [agentIds],
    );
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(`${String(row.agent_id ?? "")}|${String(row.label ?? "")}`, String(row.checksum ?? ""));
    }
    return map;
  }

  private async persist(input: {
    artifactId: number;
    versionId: number;
    version: number;
    scope: ApplicationScope;
    targets: string[];
    excluded: string[];
    dryRun: boolean;
    revertsId: number | null;
    reason: string;
    actorId: string | null;
    items: TemplateItem[];
  }): Promise<TemplateApplication> {
    const counts: Record<string, number> = {};
    for (const item of input.items) counts[item.outcome] = (counts[item.outcome] ?? 0) + 1;
    const failed = (counts.failed ?? 0) > 0;
    const status = input.dryRun ? "previewed" : failed ? "failed" : "applied";

    const { rows } = await this.db.query(
      `INSERT INTO memory_template_applications
         (artifact_id, version_id, scope, targets, excluded, dry_run, status, counts,
          reverts_id, reason, requested_by)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8::jsonb, $9, $10, $11)
       RETURNING id, created_at`,
      [
        input.artifactId,
        input.versionId,
        input.scope,
        input.targets,
        input.excluded,
        input.dryRun,
        status,
        JSON.stringify(counts),
        input.revertsId,
        input.reason,
        input.actorId,
      ],
    );
    const id = Number(rows[0]?.id ?? 0);

    for (const item of input.items) {
      await this.db.query(
        // tenant: by user_id — исход применения принадлежит владельцу агента
        `INSERT INTO memory_template_application_items
           (application_id, user_id, agent_id, label, previous_checksum, next_checksum,
            outcome, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (application_id, agent_id, label) DO NOTHING`,
        [
          id,
          item.userId,
          item.agentId,
          item.label,
          item.previousChecksum,
          item.nextChecksum,
          item.outcome,
          item.detail,
        ],
      );
    }

    return {
      id,
      artifactId: input.artifactId,
      versionId: input.versionId,
      version: input.version,
      scope: input.scope,
      targets: input.targets,
      excluded: input.excluded,
      dryRun: input.dryRun,
      status: status as TemplateApplication["status"],
      counts,
      revertsId: input.revertsId,
      reason: input.reason,
      createdAt: String(rows[0]?.created_at ?? ""),
      items: input.items,
    };
  }
}

function templateBlocks(body: unknown): Array<{ label: SyncedBlockLabel; value: string }> {
  const blocks = (body as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw badRequest("В версии шаблона нет блоков");
  }
  const result: Array<{ label: SyncedBlockLabel; value: string }> = [];
  for (const entry of blocks) {
    const block = entry as { label?: unknown; value?: unknown };
    const label = String(block.label ?? "");
    // Набор из шести блоков закрыт (инвариант 28). Версия его уже
    // проходила при создании, но применение — второй рубеж: строка могла
    // приехать из восстановленной копии со старым набором.
    if (!(SYNCED_BLOCK_LABELS as readonly string[]).includes(label)) continue;
    if (typeof block.value !== "string") continue;
    result.push({ label: label as SyncedBlockLabel, value: block.value });
  }
  if (result.length === 0) throw badRequest("В версии шаблона нет применимых блоков");
  return result;
}

function normalizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const ids = values
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0 && value.length <= 128);
  return [...new Set(ids)];
}

function toApplication(row: Record<string, unknown>): TemplateApplication {
  return {
    id: Number(row.id ?? 0),
    artifactId: Number(row.artifact_id ?? 0),
    versionId: Number(row.version_id ?? 0),
    version: Number(row.version ?? 0),
    scope: String(row.scope ?? "agent") as ApplicationScope,
    targets: Array.isArray(row.targets) ? row.targets.map((value) => String(value)) : [],
    excluded: Array.isArray(row.excluded) ? row.excluded.map((value) => String(value)) : [],
    dryRun: row.dry_run === true,
    status: String(row.status ?? "previewed") as TemplateApplication["status"],
    counts: (row.counts ?? {}) as Record<string, number>,
    revertsId: row.reverts_id === null || row.reverts_id === undefined
      ? null
      : Number(row.reverts_id),
    reason: String(row.reason ?? ""),
    createdAt: String(row.created_at ?? ""),
    items: [],
  };
}

function toItem(row: Record<string, unknown>): TemplateItem {
  return {
    agentId: String(row.agent_id ?? ""),
    userId: Number(row.user_id ?? 0),
    label: String(row.label ?? "") as SyncedBlockLabel,
    previousChecksum: row.previous_checksum === null || row.previous_checksum === undefined
      ? null
      : String(row.previous_checksum),
    nextChecksum: String(row.next_checksum ?? ""),
    outcome: String(row.outcome ?? "skipped") as ItemOutcome,
    detail: String(row.detail ?? ""),
  };
}
