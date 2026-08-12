/**
 * Memory Doctor.
 *
 * Диагностика памяти, у которой нет права записи. Она читает, строит
 * отчёт по разделам и складывает предложения; ни одно предложение не
 * применяется само. Применяет его человек — администратор или сам
 * пользователь из Mini App, — и применение идёт через тот же конвейер,
 * которым пишет Curator: версия факта шага 15, объединение сущностей
 * шага 15 или явное состояние синхронизации блока. Второго пути в
 * память здесь нет (инвариант 18).
 *
 * Чего он не делает:
 *
 *   1. Не выполняется в пути ответа человеку: единственная точка
 *      запуска — задание очереди, как у Curator. После сообщения он не
 *      запускается ни при каких условиях (требование 5 шага 17).
 *   2. Не исправляет найденное. `run()` пишет только отчёт и журнал
 *      предложений — обе таблицы журнальные.
 *   3. Не трогает `persona` и `human`: у блоков есть свой владелец —
 *      `MemoryBlockSync`, и Doctor может лишь попросить пересборку.
 *   4. Не выносит в отчёт сырой пользовательский текст сверх того, что
 *      само является доказательством, — за это отвечает `EXCERPT_LIMIT`
 *      в наборе проверок.
 */

import type { Database } from "../../db.js";
import type { Logger } from "../../logger.js";
import type { JobEnvelopeInput } from "../../jobs/envelope.js";
import { dedupKey } from "../../jobs/policy.js";
import type { GraphNodeType } from "../graph-repository.js";
import type { TemporalMemoryLayer } from "../temporal/index.js";
import { MemoryStatusError } from "../temporal/status.js";
import type { MemoryActor } from "../temporal/versions.js";
import {
  DOCTOR_CHECKS,
  DOCTOR_CHECKS_VERSION,
  type DoctorActionType,
  type DoctorCheck,
  type DoctorCheckId,
  type DoctorFinding,
} from "./checks.js";

export const MEMORY_DOCTOR_JOB_TYPE = "memory_doctor";

/**
 * Откуда пришёл запуск. Список закрыт и совпадает с ограничением схемы:
 * «после каждого сообщения» здесь нет намеренно.
 */
export const DOCTOR_TRIGGERS = [
  "admin",
  "user",
  "memory_growth",
  "conflict_detected",
  "schema_version_changed",
  "scheduled",
  "before_export",
  "after_backfill",
] as const;

export type DoctorTrigger = (typeof DOCTOR_TRIGGERS)[number];

export interface DoctorBudget {
  /** Сколько проверок разрешено выполнить за прогон. */
  maxChecks: number;
  /** Предел строк на проверку — он же `$2` в каждом запросе. */
  maxRowsPerCheck: number;
  maxDurationMs: number;
}

export const DEFAULT_DOCTOR_BUDGET: DoctorBudget = {
  maxChecks: DOCTOR_CHECKS.length,
  maxRowsPerCheck: 50,
  maxDurationMs: 20_000,
};

export type DoctorSectionStatus = "checked" | "not_applicable" | "skipped" | "failed";

export interface DoctorSection {
  check: DoctorCheckId;
  title: string;
  status: DoctorSectionStatus;
  findings: number;
  /** Почему раздел не выполнен. Пустой раздел и невыполненный — разное. */
  reason?: string;
}

export interface DoctorReport {
  reportId: number | null;
  reportKey: string;
  trigger: DoctorTrigger;
  status: "succeeded" | "partial" | "failed";
  checksVersion: number;
  sections: DoctorSection[];
  findings: DoctorFinding[];
  budget: DoctorBudget & { spentMs: number };
}

export interface DoctorActionRow {
  id: number;
  reportId: number;
  findingId: string;
  checkId: DoctorCheckId;
  actionType: DoctorActionType;
  nodeId: number | null;
  proposal: Record<string, unknown>;
  status: "proposed" | "applied" | "rejected" | "rolled_back";
}

interface NodeSnapshot {
  id: string;
  node_type: GraphNodeType;
  canonical_key: string;
  title: string;
  text_content: string | null;
  status: string;
  sensitivity: "normal" | "sensitive" | "high";
}

export class MemoryDoctorService {
  constructor(
    private readonly db: Database,
    private readonly memory: TemporalMemoryLayer,
    private readonly logger: Logger,
    private readonly enabled: boolean,
    private readonly checks: readonly DoctorCheck[] = DOCTOR_CHECKS,
  ) {}

  get active(): boolean {
    return this.enabled && this.memory.enabled;
  }

  /**
   * Намерение запустить диагностику.
   *
   * Как у Curator: запись в `job_outbox` в чужой транзакции, дедупликация
   * по пользователю. Две диагностики одного человека рядом дали бы два
   * отчёта об одном состоянии и два набора предложений на одну проблему.
   */
  intent(input: {
    userId: number;
    trigger: DoctorTrigger;
    reportKey: string;
    traceId: string;
    conversationId?: string | null;
  }): JobEnvelopeInput {
    return {
      type: MEMORY_DOCTOR_JOB_TYPE,
      queue: "memory",
      idempotencyKey: `${MEMORY_DOCTOR_JOB_TYPE}:${input.userId}:${input.reportKey}`,
      traceId: input.traceId,
      userId: input.userId,
      conversationId: input.conversationId ?? null,
      agentId: null,
      payload: { report_key: input.reportKey, trigger: input.trigger },
      dedupKey: dedupKey({
        queue: "memory",
        type: MEMORY_DOCTOR_JOB_TYPE,
        mode: "keep_last_if_active",
        userId: input.userId,
      }),
      dedupMode: "keep_last_if_active",
      deadlineMs: 15 * 60_000,
      source: "system",
      // Находки ссылаются на личные записи: конверт объявляет это сам.
      privacy: "restricted",
    };
  }

  /**
   * Выполнить диагностику.
   *
   * Прогон воспроизводим: те же данные и та же версия набора дают тот же
   * отчёт. Поэтому в отчёт попадает и версия набора, и бюджет, и статус
   * КАЖДОГО раздела — включая тот, что не выполнялся.
   */
  async run(input: {
    userId: number;
    reportKey: string;
    trigger: DoctorTrigger;
    signal?: AbortSignal;
    budget?: Partial<DoctorBudget>;
  }): Promise<DoctorReport> {
    const budget: DoctorBudget = { ...DEFAULT_DOCTOR_BUDGET, ...input.budget };
    const started = Date.now();
    const sections: DoctorSection[] = [];
    const findings: DoctorFinding[] = [];
    let failed = 0;
    let executed = 0;

    if (!this.active) {
      return {
        reportId: null,
        reportKey: input.reportKey,
        trigger: input.trigger,
        status: "failed",
        checksVersion: DOCTOR_CHECKS_VERSION,
        sections: this.checks.map((check) => ({
          check: check.id, title: check.title, status: "skipped" as const,
          findings: 0, reason: "memory_doctor_disabled",
        })),
        findings: [],
        budget: { ...budget, spentMs: 0 },
      };
    }

    await this.db.withUserScope(
      { userId: input.userId, label: "memory.doctor.run", inherit: true },
      async () => {
        for (const check of this.checks) {
          const spent = Date.now() - started;
          if (input.signal?.aborted || executed >= budget.maxChecks || spent >= budget.maxDurationMs) {
            // Бюджет — это часть отчёта, а не тихое усечение: раздел
            // остаётся в отчёте со своей причиной.
            sections.push({
              check: check.id, title: check.title, status: "skipped",
              findings: 0, reason: input.signal?.aborted ? "aborted" : "budget_exhausted",
            });
            continue;
          }
          if (check.dependsOn && !await this.tableExists(check.dependsOn)) {
            sections.push({
              check: check.id, title: check.title, status: "not_applicable",
              findings: 0, reason: `${check.dependsOn} отсутствует`,
            });
            continue;
          }
          try {
            const { rows } = await this.db.query<Record<string, unknown>>(
              check.sql, [input.userId, budget.maxRowsPerCheck],
            );
            executed += 1;
            const produced = rows.map((row) => check.finding(row));
            findings.push(...produced);
            sections.push({
              check: check.id, title: check.title, status: "checked", findings: produced.length,
            });
          } catch (error) {
            failed += 1;
            executed += 1;
            // Отказ одной проверки не отменяет отчёт: половина
            // диагностики полезнее её отсутствия, если сказано, какая.
            sections.push({
              check: check.id, title: check.title, status: "failed", findings: 0,
              reason: error instanceof Error ? error.name : "unknown_error",
            });
          }
        }
      },
    );

    const status: DoctorReport["status"] = failed === 0
      ? (sections.some((section) => section.status === "skipped") ? "partial" : "succeeded")
      : "partial";
    const report: DoctorReport = {
      reportId: null,
      reportKey: input.reportKey,
      trigger: input.trigger,
      status,
      checksVersion: DOCTOR_CHECKS_VERSION,
      sections,
      findings,
      budget: { ...budget, spentMs: Date.now() - started },
    };
    report.reportId = await this.persist(input.userId, report);
    this.logger.info("Memory Doctor построил отчёт", {
      status, findings: findings.length, checks: executed, failed,
    });
    return report;
  }

  /** Сохранить отчёт и предложения. Повторный прогон того же ключа не удваивает их. */
  private async persist(userId: number, report: DoctorReport): Promise<number | null> {
    return await this.db.withUserScope(
      { userId, label: "memory.doctor.persist", inherit: true },
      async () => await this.db.transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO memory_doctor_reports (
             user_id, report_key, trigger_reason, status, checks_version,
             sections, findings, budget, completed_at
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now())
           ON CONFLICT (user_id, report_key) DO NOTHING
           RETURNING id`,
          [
            userId, report.reportKey, report.trigger, report.status, report.checksVersion,
            JSON.stringify(report.sections), JSON.stringify(report.findings),
            JSON.stringify(report.budget),
          ],
        );
        const reportId = rows[0] ? Number(rows[0].id) : null;
        if (reportId === null) return null;
        for (const finding of report.findings) {
          if (!finding.proposal) continue;
          await client.query(
            `INSERT INTO memory_doctor_actions (
               user_id, report_id, finding_id, check_id, action_type, node_id, proposal
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
             ON CONFLICT (user_id, report_id, finding_id) DO NOTHING`,
            [
              userId, reportId, finding.id, finding.check,
              finding.proposal.actionType, finding.proposal.nodeId,
              JSON.stringify({ ...finding.proposal.detail, subject: finding.subject.ids }),
            ],
          );
        }
        return reportId;
      }),
    );
  }

  async latestReport(userId: number): Promise<DoctorReport | null> {
    return await this.db.withUserScope(
      { userId, label: "memory.doctor.latest", inherit: true },
      async () => {
        const { rows } = await this.db.query<{
          id: string; report_key: string; trigger_reason: DoctorTrigger;
          status: DoctorReport["status"]; checks_version: number;
          sections: DoctorSection[]; findings: DoctorFinding[];
          budget: DoctorReport["budget"];
        }>(
          `SELECT id, report_key, trigger_reason, status, checks_version, sections, findings, budget
             FROM memory_doctor_reports
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 1`,
          [userId],
        );
        const row = rows[0];
        if (!row) return null;
        return {
          reportId: Number(row.id),
          reportKey: row.report_key,
          trigger: row.trigger_reason,
          status: row.status,
          checksVersion: row.checks_version,
          sections: row.sections,
          findings: row.findings,
          budget: row.budget,
        };
      },
    );
  }

  async proposals(userId: number, reportId: number): Promise<DoctorActionRow[]> {
    return await this.db.withUserScope(
      { userId, label: "memory.doctor.proposals", inherit: true },
      async () => {
        const { rows } = await this.db.query<Record<string, unknown>>(
          `SELECT id, report_id, finding_id, check_id, action_type, node_id, proposal, status
             FROM memory_doctor_actions
            WHERE user_id = $1 AND report_id = $2
            ORDER BY id`,
          [userId, reportId],
        );
        return rows.map((row) => ({
          id: Number(row.id),
          reportId: Number(row.report_id),
          findingId: String(row.finding_id),
          checkId: String(row.check_id) as DoctorCheckId,
          actionType: String(row.action_type) as DoctorActionType,
          nodeId: row.node_id === null ? null : Number(row.node_id),
          proposal: (row.proposal ?? {}) as Record<string, unknown>,
          status: String(row.status) as DoctorActionRow["status"],
        }));
      },
    );
  }

  /**
   * Предпросмотр: что именно изменится.
   *
   * Ничего не пишет и ничем не отличается от применения по данным,
   * которые читает, — иначе предпросмотр показывал бы не то, что
   * произойдёт.
   */
  async preview(userId: number, actionId: number): Promise<{
    action: DoctorActionRow;
    diff: Array<{ field: string; from: string | null; to: string | null }>;
  } | null> {
    const action = await this.action(userId, actionId);
    if (!action) return null;
    const node = action.nodeId === null ? null : await this.node(userId, action.nodeId);
    return { action, diff: this.diffFor(action, node) };
  }

  /**
   * Применить предложение.
   *
   * Только по явному действию человека: `actor` обязателен и попадает в
   * журнал. Снимок пишется до изменения — откат по нему, а не по
   * догадке о прежнем состоянии.
   */
  async apply(
    userId: number,
    actionId: number,
    actor: { type: Extract<MemoryActor, "user" | "admin">; id: string },
  ): Promise<{ ok: boolean; code?: string }> {
    const action = await this.action(userId, actionId);
    if (!action) return { ok: false, code: "doctor_action_not_found" };
    if (action.status !== "proposed") return { ok: false, code: "doctor_action_not_open" };

    try {
      return await this.db.withUserScope(
        { userId, label: "memory.doctor.apply", inherit: true },
        async () => await this.db.transaction(async (client) => {
          const snapshot = await this.performApply(client, userId, action, actor);
          if (!snapshot) return { ok: false, code: "doctor_action_unsupported" };
          await client.query(
            `UPDATE memory_doctor_actions
                SET status = 'applied', snapshot = $3::jsonb,
                    actor_type = $4, actor_id = $5, applied_at = now()
              WHERE user_id = $1 AND id = $2 AND status = 'proposed'`,
            [userId, actionId, JSON.stringify(snapshot), actor.type, actor.id.slice(0, 200)],
          );
          return { ok: true };
        }),
      );
    } catch (error) {
      if (error instanceof MemoryStatusError) {
        // Запрет перехода — это ответ памяти, а не поломка: удалённый
        // факт не воскрешается предложением диагностики.
        this.logger.info("Предложение Doctor отклонено памятью", { code: error.code });
        return { ok: false, code: error.code };
      }
      throw error;
    }
  }

  /** Отклонить предложение, ничего не меняя в памяти. */
  async reject(userId: number, actionId: number): Promise<boolean> {
    return await this.db.withUserScope(
      { userId, label: "memory.doctor.reject", inherit: true },
      async () => {
        const { rowCount } = await this.db.query(
          `UPDATE memory_doctor_actions SET status = 'rejected'
            WHERE user_id = $1 AND id = $2 AND status = 'proposed'`,
          [userId, actionId],
        );
        return Boolean(rowCount);
      },
    );
  }

  /** Откат применённого предложения по снимку. Повторный откат ничего не делает. */
  async rollback(userId: number, actionId: number): Promise<boolean> {
    const action = await this.action(userId, actionId);
    if (!action || action.status !== "applied") return false;
    return await this.db.withUserScope(
      { userId, label: "memory.doctor.rollback", inherit: true },
      async () => await this.db.transaction(async (client) => {
        const { rows } = await client.query<{ snapshot: Record<string, unknown> }>(
          `SELECT snapshot FROM memory_doctor_actions
            WHERE user_id = $1 AND id = $2 AND status = 'applied'`,
          [userId, actionId],
        );
        const snapshot = rows[0]?.snapshot;
        if (!snapshot) return false;
        const restored = await this.performRollback(client, userId, action, snapshot);
        if (!restored) return false;
        await client.query(
          `UPDATE memory_doctor_actions SET status = 'rolled_back', rolled_back_at = now()
            WHERE user_id = $1 AND id = $2 AND status = 'applied'`,
          [userId, actionId],
        );
        return true;
      }),
    );
  }

  private async performApply(
    client: Parameters<TemporalMemoryLayer["versions"]["recordFact"]>[0],
    userId: number,
    action: DoctorActionRow,
    actor: { type: Extract<MemoryActor, "user" | "admin">; id: string },
  ): Promise<Record<string, unknown> | null> {
    switch (action.actionType) {
      case "merge_duplicate": {
        const keep = Number(action.proposal.keep_node_id ?? action.nodeId);
        const source = this.otherNodeId(action, keep);
        if (!Number.isFinite(keep) || source === null) return null;
        const mergeId = await this.memory.entities.merge(client, {
          userId, sourceNodeId: source, targetNodeId: keep,
          score: 1, reason: `doctor:${action.checkId}`, actorType: actor.type,
        });
        return { merge_id: mergeId };
      }
      case "request_confirmation":
        return await this.restatus(client, userId, action, "quarantined", actor);
      case "mark_forgotten":
        return await this.restatus(client, userId, action, "forgotten", actor);
      case "raise_privacy":
        return await this.restatus(client, userId, action, null, actor, "sensitive");
      case "archive_edge": {
        const edgeId = Number(action.proposal.edge_id);
        if (!Number.isFinite(edgeId)) return null;
        const { rows } = await client.query<{ status: string }>(
          `UPDATE memory_edges SET status = 'archived'
            WHERE user_id = $1 AND id = $2 AND status <> 'archived'
            RETURNING (SELECT status FROM memory_edges WHERE user_id = $1 AND id = $2) AS status`,
          [userId, edgeId],
        );
        if (!rows[0]) return null;
        return { edge_id: edgeId, status: "active" };
      }
      case "resync_block": {
        const label = String(action.proposal.block_label ?? "");
        if (!label) return null;
        const { rows } = await client.query<{ status: string }>(
          `UPDATE letta_memory_block_sync SET status = 'pending'
            WHERE user_id = $1 AND label = $2
            RETURNING status`,
          [userId, label],
        );
        if (!rows[0]) return null;
        return { block_label: label, status: rows[0].status };
      }
      default:
        return null;
    }
  }

  /**
   * Изменение статуса или чувствительности факта — новой версией.
   *
   * Прежнее значение не переписывается: у памяти нет операции «поправить
   * задним числом», и диагностика её не заводит.
   */
  private async restatus(
    client: Parameters<TemporalMemoryLayer["versions"]["recordFact"]>[0],
    userId: number,
    action: DoctorActionRow,
    status: "quarantined" | "forgotten" | null,
    actor: { type: Extract<MemoryActor, "user" | "admin">; id: string },
    sensitivity?: "sensitive",
  ): Promise<Record<string, unknown> | null> {
    if (action.nodeId === null) return null;
    const node = await this.node(userId, action.nodeId);
    if (!node) return null;
    await this.memory.versions.recordFact(client, {
      userId,
      nodeType: node.node_type,
      canonicalKey: node.canonical_key,
      title: node.title,
      textContent: node.text_content,
      status: status ?? undefined,
      sensitivity: sensitivity ?? node.sensitivity,
      evidence: [{
        sourceType: "doctor",
        sourceId: `doctor:${action.checkId}`,
        sourceAt: new Date(),
        excerpt: `doctor:${action.checkId}`,
        confidence: 1,
      }],
      changeReason: `doctor:${action.checkId}`,
      actorType: actor.type,
    });
    return { node_id: action.nodeId, status: node.status, sensitivity: node.sensitivity };
  }

  private async performRollback(
    client: Parameters<TemporalMemoryLayer["versions"]["recordFact"]>[0],
    userId: number,
    action: DoctorActionRow,
    snapshot: Record<string, unknown>,
  ): Promise<boolean> {
    switch (action.actionType) {
      case "merge_duplicate":
        return await this.memory.entities.rollbackMerge(
          client, userId, Number(snapshot.merge_id),
        );
      case "archive_edge": {
        const { rowCount } = await client.query(
          `UPDATE memory_edges SET status = $3
            WHERE user_id = $1 AND id = $2`,
          [userId, Number(snapshot.edge_id), String(snapshot.status ?? "active")],
        );
        return Boolean(rowCount);
      }
      case "resync_block": {
        const { rowCount } = await client.query(
          `UPDATE letta_memory_block_sync SET status = $3
            WHERE user_id = $1 AND label = $2`,
          [userId, String(snapshot.block_label ?? ""), String(snapshot.status ?? "pending")],
        );
        return Boolean(rowCount);
      }
      default: {
        // Статус и чувствительность возвращаются такой же новой версией:
        // история остаётся полной, включая сам откат.
        const node = action.nodeId === null ? null : await this.node(userId, action.nodeId);
        if (!node) return false;
        await this.memory.versions.recordFact(client, {
          userId,
          nodeType: node.node_type,
          canonicalKey: node.canonical_key,
          title: node.title,
          textContent: node.text_content,
          status: snapshot.status as never,
          sensitivity: (snapshot.sensitivity ?? node.sensitivity) as NodeSnapshot["sensitivity"],
          evidence: [{
            sourceType: "doctor",
            sourceId: `doctor:rollback:${action.checkId}`,
            sourceAt: new Date(),
            excerpt: `doctor:rollback:${action.checkId}`,
            confidence: 1,
          }],
          changeReason: `doctor:rollback:${action.checkId}`,
          actorType: "system",
        });
        return true;
      }
    }
  }

  private diffFor(
    action: DoctorActionRow,
    node: NodeSnapshot | null,
  ): Array<{ field: string; from: string | null; to: string | null }> {
    switch (action.actionType) {
      case "merge_duplicate":
        return [{
          field: "entity",
          from: `node:${this.otherNodeId(action, Number(action.nodeId)) ?? "?"}`,
          to: `node:${action.proposal.keep_node_id ?? action.nodeId}`,
        }];
      case "request_confirmation":
        return [{ field: "status", from: node?.status ?? null, to: "quarantined" }];
      case "mark_forgotten":
        return [{ field: "status", from: node?.status ?? null, to: "forgotten" }];
      case "raise_privacy":
        return [{ field: "sensitivity", from: node?.sensitivity ?? null, to: "sensitive" }];
      case "archive_edge":
        return [{ field: "edge.status", from: "active", to: "archived" }];
      case "resync_block":
        return [{
          field: "block.sync",
          from: String(action.proposal.sync_status ?? "unknown"),
          to: "pending",
        }];
      default:
        return [];
    }
  }

  /** Второй узел пары дубликатов: тот из подлежащих, что не «оставляем». */
  private otherNodeId(action: DoctorActionRow, keep: number): number | null {
    const explicit = Number(action.proposal.other_node_id);
    if (Number.isFinite(explicit) && explicit !== keep) return explicit;
    const subject = Array.isArray(action.proposal.subject) ? action.proposal.subject : [];
    for (const value of subject) {
      const id = Number(value);
      if (Number.isFinite(id) && id !== keep) return id;
    }
    return null;
  }

  private async action(userId: number, actionId: number): Promise<DoctorActionRow | null> {
    return await this.db.withUserScope(
      { userId, label: "memory.doctor.action", inherit: true },
      async () => {
        const { rows } = await this.db.query<Record<string, unknown>>(
          `SELECT id, report_id, finding_id, check_id, action_type, node_id, proposal, status
             FROM memory_doctor_actions
            WHERE user_id = $1 AND id = $2`,
          [userId, actionId],
        );
        const row = rows[0];
        if (!row) return null;
        return {
          id: Number(row.id),
          reportId: Number(row.report_id),
          findingId: String(row.finding_id),
          checkId: String(row.check_id) as DoctorCheckId,
          actionType: String(row.action_type) as DoctorActionType,
          nodeId: row.node_id === null ? null : Number(row.node_id),
          proposal: (row.proposal ?? {}) as Record<string, unknown>,
          status: String(row.status) as DoctorActionRow["status"],
        };
      },
    );
  }

  private async node(userId: number, nodeId: number): Promise<NodeSnapshot | null> {
    const { rows } = await this.db.query<NodeSnapshot>(
      `SELECT id, node_type, canonical_key, title, text_content, status, sensitivity
         FROM memory_nodes WHERE user_id = $1 AND id = $2`,
      [userId, nodeId],
    );
    return rows[0] ?? null;
  }

  private async tableExists(table: string): Promise<boolean> {
    const { rows } = await this.db.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${table}`],
    );
    return rows[0]?.present === true;
  }
}
