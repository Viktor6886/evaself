/**
 * Единый реестр артефактов: prompts, flows, skills, policies и шаблоны
 * memory block.
 *
 * Один реестр вместо четырёх почти одинаковых — тип артефакта здесь колонка,
 * а не отдельная система версий (шаг 13 это прямо запрещает). Prompt и flow
 * при этом остаются независимыми типами: общая модель хранения не делает их
 * одной сущностью.
 *
 * Три уровня и три разных вопроса:
 *   артефакт    — что это такое и как называется;
 *   версия      — что именно в нём написано, неизменяемо;
 *   публикация  — что из этого действует в окружении прямо сейчас.
 *
 * Неизменяемость версии держит триггер в схеме, а не этот класс: код,
 * который «просто не делает UPDATE», защищает ровно до первой ошибки. Здесь
 * же — правила перехода, публикация и откат.
 *
 * Артефакты общесистемные: у них нет владельца среди пользователей Евы, и
 * граница арендатора к ним не применяется. Доступ ограничен ролью
 * административного маршрута и записывается в аудит.
 */

import { createHash } from "node:crypto";

import { badRequest, notFound } from "../errors.js";

import {
  type ArtifactKind,
  type ValidationReport,
  artifactChecksum,
  diffArtifactBodies,
  validateArtifactBody,
} from "./validation.js";

export type ArtifactVersionStatus = "draft" | "candidate" | "approved" | "archived";

export interface ArtifactRow {
  id: number;
  kind: ArtifactKind;
  slug: string;
  title: string;
  description: string;
  archivedAt: string | null;
}

export interface ArtifactVersionRow {
  id: number;
  artifactId: number;
  version: number;
  body: unknown;
  checksum: string;
  parentId: number | null;
  status: ArtifactVersionStatus;
  validation: unknown;
  testResult: unknown;
  createdAt: string;
}

export interface PublicationRow {
  id: number;
  artifactId: number;
  environment: string;
  versionId: number;
  version: number;
  rolloutPercent: number;
  previousVersionId: number | null;
  publishedAt: string;
  reason: string;
  retiredAt: string | null;
}

export interface ArtifactDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Кем может быть зафиксирована версия артефакта. Совпадает с CHECK схемы. */
export const USAGE_RUN_KINDS = [
  "turn",
  "job",
  "tool_call",
  "insight",
  "research",
  "eval",
] as const;

export type UsageRunKind = (typeof USAGE_RUN_KINDS)[number];

export class ArtifactRegistry {
  private readonly db: ArtifactDatabase;

  constructor(db: ArtifactDatabase) {
    this.db = db;
  }

  async list(kind?: ArtifactKind): Promise<ArtifactRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, kind, slug, title, description, archived_at
         FROM artifacts
        WHERE ($1::text IS NULL OR kind = $1)
        ORDER BY kind, slug`,
      [kind ?? null],
    );
    return rows.map(toArtifact);
  }

  async create(input: {
    kind: ArtifactKind;
    slug: string;
    title: string;
    description?: string;
    createdBy?: string | null;
  }): Promise<ArtifactRow> {
    const { rows } = await this.db.query(
      `INSERT INTO artifacts (kind, slug, title, description, created_by)
       VALUES ($1, $2, $3, COALESCE($4, ''), $5)
       ON CONFLICT (kind, slug) DO NOTHING
       RETURNING id, kind, slug, title, description, archived_at`,
      [input.kind, input.slug, input.title, input.description ?? "", input.createdBy ?? null],
    );
    if (rows.length === 0) {
      throw badRequest(`Артефакт ${input.kind}/${input.slug} уже существует`);
    }
    return toArtifact(rows[0]!);
  }

  async versions(artifactId: number): Promise<ArtifactVersionRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, artifact_id, version, body, checksum, parent_id, status,
              validation, test_result, created_at
         FROM artifact_versions
        WHERE artifact_id = $1
        ORDER BY version DESC`,
      [artifactId],
    );
    return rows.map(toVersion);
  }

  async version(versionId: number): Promise<ArtifactVersionRow> {
    const { rows } = await this.db.query(
      `SELECT id, artifact_id, version, body, checksum, parent_id, status,
              validation, test_result, created_at
         FROM artifact_versions
        WHERE id = $1`,
      [versionId],
    );
    if (rows.length === 0) throw notFound(`версия артефакта ${versionId} не найдена`);
    return toVersion(rows[0]!);
  }

  /**
   * Создать версию.
   *
   * Содержимое проверяется до записи, отпечаток считается здесь же, а
   * родителем становится последняя версия артефакта. Совпадение отпечатка с
   * родителем отклоняется: версия, ничем не отличающаяся от предыдущей,
   * засоряет историю и делает откат неоднозначным.
   */
  async createVersion(input: {
    artifactId: number;
    body: unknown;
    createdBy?: string | null;
  }): Promise<{ version: ArtifactVersionRow; validation: ValidationReport }> {
    const artifact = await this.requireArtifact(input.artifactId);
    const validation = validateArtifactBody(artifact.kind, input.body);
    const checksum = artifactChecksum(input.body);

    const { rows: previous } = await this.db.query(
      `SELECT id, checksum, version FROM artifact_versions
        WHERE artifact_id = $1 ORDER BY version DESC LIMIT 1`,
      [input.artifactId],
    );
    const parent = previous[0];
    if (parent && String(parent.checksum) === checksum) {
      throw badRequest("Содержимое совпадает с предыдущей версией: новая версия не нужна");
    }

    const { rows } = await this.db.query(
      `INSERT INTO artifact_versions
         (artifact_id, version, body, checksum, parent_id, status, validation, created_by)
       VALUES ($1, COALESCE((SELECT max(version) + 1 FROM artifact_versions WHERE artifact_id = $1), 1),
               $2::jsonb, $3, $4, 'draft', $5::jsonb, $6)
       RETURNING id, artifact_id, version, body, checksum, parent_id, status,
                 validation, test_result, created_at`,
      [
        input.artifactId,
        JSON.stringify(input.body),
        checksum,
        parent ? Number(parent.id) : null,
        JSON.stringify(validation),
        input.createdBy ?? null,
      ],
    );
    return { version: toVersion(rows[0]!), validation };
  }

  /**
   * Двинуть версию по жизненному циклу.
   *
   * Разрешены только переходы вперёд. Возврат в черновик схема запрещает
   * триггером — здесь тот же запрет назван словами, чтобы отказ был понятен
   * до похода в базу.
   */
  async setStatus(
    versionId: number,
    status: Exclude<ArtifactVersionStatus, "draft">,
    actor?: string | null,
  ): Promise<ArtifactVersionRow> {
    const current = await this.version(versionId);
    const order: ArtifactVersionStatus[] = ["draft", "candidate", "approved", "archived"];
    if (order.indexOf(status) <= order.indexOf(current.status)) {
      throw badRequest(
        `Переход ${current.status} → ${status} не разрешён: жизненный цикл движется только вперёд`,
      );
    }
    const approving = status === "approved";
    const { rows } = await this.db.query(
      `UPDATE artifact_versions
          SET status = $2,
              approved_at = CASE WHEN $3::boolean THEN now() ELSE approved_at END,
              approved_by = CASE WHEN $3::boolean THEN $4::uuid ELSE approved_by END
        WHERE id = $1
        RETURNING id, artifact_id, version, body, checksum, parent_id, status,
                  validation, test_result, created_at`,
      [versionId, status, approving, actor ?? null],
    );
    return toVersion(rows[0]!);
  }

  /** Что действует в окружении прямо сейчас. */
  async active(artifactId: number, environment: string): Promise<PublicationRow | null> {
    const { rows } = await this.db.query(
      `SELECT p.id, p.artifact_id, p.environment, p.version_id, v.version,
              p.rollout_percent, p.previous_version_id, p.published_at, p.reason, p.retired_at
         FROM artifact_publications p
         JOIN artifact_versions v ON v.id = p.version_id
        WHERE p.artifact_id = $1 AND p.environment = $2 AND p.retired_at IS NULL`,
      [artifactId, environment],
    );
    return rows.length === 0 ? null : toPublication(rows[0]!);
  }

  async history(artifactId: number, environment: string): Promise<PublicationRow[]> {
    const { rows } = await this.db.query(
      `SELECT p.id, p.artifact_id, p.environment, p.version_id, v.version,
              p.rollout_percent, p.previous_version_id, p.published_at, p.reason, p.retired_at
         FROM artifact_publications p
         JOIN artifact_versions v ON v.id = p.version_id
        WHERE p.artifact_id = $1 AND p.environment = $2
        ORDER BY p.published_at DESC, p.id DESC`,
      [artifactId, environment],
    );
    return rows.map(toPublication);
  }

  /**
   * Опубликовать версию в окружении.
   *
   * Неутверждённая версия не публикуется: `candidate` — это «предложено», а
   * не «решено». Прежняя публикация снимается и остаётся в истории, а её
   * версия запоминается как точка отката — иначе откат требовал бы разбора
   * истории руками в тот момент, когда разбирать некогда.
   */
  async publish(input: {
    artifactId: number;
    environment: string;
    versionId: number;
    rolloutPercent?: number;
    reason?: string;
    publishedBy?: string | null;
  }): Promise<PublicationRow> {
    const version = await this.version(input.versionId);
    if (version.artifactId !== input.artifactId) {
      throw badRequest("Версия принадлежит другому артефакту");
    }
    if (version.status !== "approved") {
      throw badRequest(
        `Версия ${version.version} в состоянии ${version.status}: публикуется только утверждённая`,
      );
    }
    const rollout = input.rolloutPercent ?? 100;
    if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
      throw badRequest("Процент раскатки — целое число от 0 до 100");
    }

    const previous = await this.active(input.artifactId, input.environment);
    if (previous) await this.retire(previous.id);

    const { rows } = await this.db.query(
      `INSERT INTO artifact_publications
         (artifact_id, environment, version_id, rollout_percent, previous_version_id,
          published_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, ''))
       RETURNING id, artifact_id, environment, version_id, rollout_percent,
                 previous_version_id, published_at, reason, retired_at`,
      [
        input.artifactId,
        input.environment,
        input.versionId,
        rollout,
        previous?.versionId ?? null,
        input.publishedBy ?? null,
        input.reason ?? "",
      ],
    );
    return { ...toPublication(rows[0]!), version: version.version };
  }

  /**
   * Откат одним действием.
   *
   * Возвращает ту версию, что действовала до текущей публикации. История не
   * переписывается: откат — это ещё одна публикация, а не удаление
   * предыдущей. Поэтому откат отката тоже работает и виден в истории.
   */
  async rollback(input: {
    artifactId: number;
    environment: string;
    reason: string;
    publishedBy?: string | null;
  }): Promise<PublicationRow> {
    const current = await this.active(input.artifactId, input.environment);
    if (!current) {
      throw badRequest(`В окружении ${input.environment} нечего откатывать: публикации нет`);
    }
    if (current.previousVersionId === null) {
      throw badRequest("Это первая публикация артефакта: откатывать не на что");
    }
    if (!input.reason.trim()) {
      // Причина отката теряется первой, а спрашивают о ней всегда.
      throw badRequest("Откат требует причины");
    }
    await this.retire(current.id);
    const target = await this.version(current.previousVersionId);
    const { rows } = await this.db.query(
      `INSERT INTO artifact_publications
         (artifact_id, environment, version_id, rollout_percent, previous_version_id,
          published_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, artifact_id, environment, version_id, rollout_percent,
                 previous_version_id, published_at, reason, retired_at`,
      [
        input.artifactId,
        input.environment,
        current.previousVersionId,
        current.rolloutPercent,
        current.versionId,
        input.publishedBy ?? null,
        input.reason,
      ],
    );
    return { ...toPublication(rows[0]!), version: target.version };
  }

  /**
   * Что действует для конкретного субъекта прямо сейчас.
   *
   * Единственный способ узнать версию во время выполнения. Отдельно от
   * `active()` потому, что публикация — это не только «какая версия», но и
   * «какой доле»: при `rollout_percent < 100` версия действует не для всех.
   *
   * Доля считается детерминированно от субъекта, а не случайно. Случайный
   * бросок означал бы, что один и тот же человек в соседних ходах работает
   * то со старым промптом, то с новым, — а это не раскатка, а мерцание.
   * Тот же субъект при том же проценте всегда получает тот же ответ.
   */
  async resolve(input: {
    kind: ArtifactKind;
    slug: string;
    environment: string;
    /** Кто спрашивает: идентификатор пользователя, агента или хода. */
    subject: string;
  }): Promise<{
    versionId: number;
    version: number;
    checksum: string;
    body: unknown;
    rolloutPercent: number;
  } | null> {
    const { rows } = await this.db.query(
      `SELECT p.version_id, p.rollout_percent, v.version, v.checksum, v.body
         FROM artifact_publications p
         JOIN artifact_versions v ON v.id = p.version_id
         JOIN artifacts a ON a.id = p.artifact_id
        WHERE a.kind = $1 AND a.slug = $2 AND a.archived_at IS NULL
          AND p.environment = $3 AND p.retired_at IS NULL`,
      [input.kind, input.slug, input.environment],
    );
    if (rows.length === 0) return null;

    const row = rows[0]!;
    const rollout = Number(row.rollout_percent ?? 0);
    // 0 % — «объявлено, но никому не выдаётся»: публикация видна в
    // истории, а действующей версии для субъекта нет.
    if (rollout <= 0) return null;
    if (rollout < 100 && bucketOf(`${input.slug}:${input.subject}`) >= rollout) return null;

    return {
      versionId: Number(row.version_id ?? 0),
      version: Number(row.version ?? 0),
      checksum: String(row.checksum ?? ""),
      body: row.body ?? null,
      rolloutPercent: rollout,
    };
  }

  /** Семантический diff двух версий — путями и размерами, без содержимого. */
  async diff(fromVersionId: number, toVersionId: number) {
    const [from, to] = await Promise.all([
      this.version(fromVersionId),
      this.version(toVersionId),
    ]);
    return {
      from: { id: from.id, version: from.version, checksum: from.checksum },
      to: { id: to.id, version: to.version, checksum: to.checksum },
      entries: diffArtifactBodies(from.body, to.body),
    };
  }

  /**
   * Зафиксировать, что прогон работал на этой версии.
   *
   * Повтор безвреден: один прогон фиксирует одну версию один раз, и
   * повторный вызов при восстановлении хода не должен ни падать, ни
   * плодить строки.
   */
  async recordUsage(runKind: UsageRunKind, runId: string, versionIds: number[]): Promise<number> {
    if (versionIds.length === 0) return 0;
    const { rowCount } = await this.db.query(
      `INSERT INTO artifact_usages (run_kind, run_id, version_id)
       SELECT $1, $2, unnest($3::bigint[])
       ON CONFLICT (run_kind, run_id, version_id) DO NOTHING`,
      [runKind, runId, versionIds],
    );
    return rowCount ?? 0;
  }

  /** Чем воспроизводится прогон: точные версии, на которых он выполнялся. */
  async usagesOf(runKind: UsageRunKind, runId: string): Promise<Array<{
    kind: string;
    slug: string;
    version: number;
    checksum: string;
  }>> {
    const { rows } = await this.db.query(
      `SELECT a.kind, a.slug, v.version, v.checksum
         FROM artifact_usages u
         JOIN artifact_versions v ON v.id = u.version_id
         JOIN artifacts a ON a.id = v.artifact_id
        WHERE u.run_kind = $1 AND u.run_id = $2
        ORDER BY a.kind, a.slug`,
      [runKind, runId],
    );
    return rows.map((row) => ({
      kind: String(row.kind ?? ""),
      slug: String(row.slug ?? ""),
      version: Number(row.version ?? 0),
      checksum: String(row.checksum ?? ""),
    }));
  }

  private async retire(publicationId: number): Promise<void> {
    await this.db.query(
      "UPDATE artifact_publications SET retired_at = now() WHERE id = $1 AND retired_at IS NULL",
      [publicationId],
    );
  }

  private async requireArtifact(artifactId: number): Promise<ArtifactRow> {
    const { rows } = await this.db.query(
      "SELECT id, kind, slug, title, description, archived_at FROM artifacts WHERE id = $1",
      [artifactId],
    );
    if (rows.length === 0) throw notFound(`артефакт ${artifactId} не найден`);
    return toArtifact(rows[0]!);
  }
}

/**
 * Корзина субъекта: число 0–99, устойчивое между процессами и перезапусками.
 *
 * Именно поэтому здесь хэш, а не `Math.random()` и не остаток от числового
 * идентификатора: случайное значение меняло бы версию у одного человека от
 * хода к ходу, а остаток от идентификатора выдавал бы новых пользователей
 * в одну и ту же корзину — раскатка на 10 % досталась бы не десятой части
 * людей, а десятой части диапазона идентификаторов.
 */
function bucketOf(subject: string): number {
  const digest = createHash("sha256").update(subject).digest();
  return digest.readUInt32BE(0) % 100;
}

function toArtifact(row: Record<string, unknown>): ArtifactRow {
  return {
    id: Number(row.id ?? 0),
    kind: String(row.kind ?? "") as ArtifactKind,
    slug: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    archivedAt: row.archived_at === null || row.archived_at === undefined
      ? null
      : String(row.archived_at),
  };
}

function toVersion(row: Record<string, unknown>): ArtifactVersionRow {
  return {
    id: Number(row.id ?? 0),
    artifactId: Number(row.artifact_id ?? 0),
    version: Number(row.version ?? 0),
    body: row.body ?? null,
    checksum: String(row.checksum ?? ""),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : Number(row.parent_id),
    status: String(row.status ?? "draft") as ArtifactVersionStatus,
    validation: row.validation ?? null,
    testResult: row.test_result ?? null,
    createdAt: String(row.created_at ?? ""),
  };
}

function toPublication(row: Record<string, unknown>): PublicationRow {
  return {
    id: Number(row.id ?? 0),
    artifactId: Number(row.artifact_id ?? 0),
    environment: String(row.environment ?? ""),
    versionId: Number(row.version_id ?? 0),
    version: Number(row.version ?? 0),
    rolloutPercent: Number(row.rollout_percent ?? 0),
    previousVersionId: row.previous_version_id === null || row.previous_version_id === undefined
      ? null
      : Number(row.previous_version_id),
    publishedAt: String(row.published_at ?? ""),
    reason: String(row.reason ?? ""),
    retiredAt: row.retired_at === null || row.retired_at === undefined
      ? null
      : String(row.retired_at),
  };
}
