/**
 * Запись жизненного цикла хода — shadow-режим.
 *
 * «Shadow» здесь означает буквально: путь обработки сообщения не
 * меняется, ответ пользователю от этих записей не зависит, и сбой
 * записи ход не роняет. Поэтому каждый метод молча гасит собственную
 * ошибку в лог: наблюдение не имеет права ломать наблюдаемое.
 *
 * Что здесь не хранится и не будет: промпты, ответы модели, аргументы
 * инструментов, reasoning. Только структура хода — состояния, времена,
 * ссылки на уже существующие записи и безопасный код ошибки.
 *
 * Каждый запрос к `turn_runs` несёт столбец владельца: таблица
 * пользовательская, и обращение по одному `run_id` граница арендатора
 * не пропустит — справедливо, потому что чужой `run_id` тогда правился
 * бы из чужой области.
 */

import { randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import {
  canTransition,
  InvalidTurnTransitionError,
  isTurnState,
  TERMINAL_STATES,
  type TurnState,
} from "./states.js";

export type TurnChannel = "telegram" | "webapp" | "scheduler" | "internal";

/**
 * Версия последовательности хода. Меняется вместе с самим порядком
 * состояний: иначе записи разных пайплайнов сравнивались бы между собой
 * как одинаковые.
 */
export const TURN_FLOW_VERSION = "telegram-shadow-1";

/** Столбец и значение владельца хода — граница арендатора его записей. */
export interface TurnOwner {
  column: "user_id" | "telegram_user_id";
  value: number;
}

export interface TurnIdentity {
  channel: TurnChannel;
  /** Идентификатор входящего события: update_id, id задания и т.п. */
  eventId: string | number;
  conversationId?: string | null;
}

export interface TurnStartInput extends TurnIdentity {
  userId?: number | null;
  telegramUserId?: number | null;
  updateId?: number | null;
  agentId?: string | null;
  purpose?: string | null;
  traceId?: string | null;
}

export interface TurnLinks {
  userId?: number | null;
  agentId?: string | null;
  conversationId?: string | null;
  purpose?: string | null;
  quotaMetric?: string | null;
  quotaCharged?: boolean;
  outboxId?: number | string | null;
  llmRequestId?: string | null;
  lettaSessionId?: string | null;
  /** Идентификаторы run из потока Agent SDK. */
  lettaRunIds?: string[] | null;
  traceId?: string | null;
  promptVersion?: string | null;
  flowVersion?: string | null;
}

export interface TurnHandle {
  runId: string;
  idempotencyKey: string;
  /** Ход уже был записан раньше: повторная доставка того же события. */
  duplicate: boolean;
  /** Состояние, в котором ход застали. `null` — записи ещё нет. */
  state: TurnState | null;
  /** Запись открыта: без неё все дальнейшие вызовы — no-op. */
  recorded: boolean;
  owner: TurnOwner | null;
}

/**
 * Ключ идемпотентности хода.
 *
 * Одно входящее событие — один ход, сколько бы раз Telegram ни повторил
 * доставку. Conversation входит в ключ, потому что одно и то же событие
 * может обслуживаться разными назначениями (chat и scheduler), и это
 * разные ходы, а не повтор одного. Для Telegram conversation в момент
 * приёма ещё не известен, и его место занимает `-`: ход телеграм-апдейта
 * ровно один, поэтому ключа из канала и `update_id` достаточно.
 */
export function turnIdempotencyKey(identity: TurnIdentity): string {
  const conversation = identity.conversationId?.trim() || "-";
  return `${identity.channel}:${identity.eventId}:${conversation}`;
}

/**
 * Владелец хода — на всё время хода один и тот же столбец.
 *
 * Telegram-ход начинается с проверенного `telegram_user_id`, и
 * внутренний `users.id` появляется только после канонической выборки.
 * Менять границу на полпути значило бы иметь запросы, которые до
 * определённого момента адресуют строку одним столбцом, а после —
 * другим; выбирается один, известный с самого начала.
 */
function ownerOf(input: TurnStartInput): TurnOwner | null {
  if (typeof input.telegramUserId === "number" && Number.isFinite(input.telegramUserId)) {
    return { column: "telegram_user_id", value: input.telegramUserId };
  }
  if (typeof input.userId === "number" && Number.isFinite(input.userId)) {
    return { column: "user_id", value: input.userId };
  }
  return null;
}

export class TurnLifecycle {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly enabled: boolean,
  ) {}

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Область арендатора для записей хода.
   *
   * Внутри хода пользователя область уже объявлена, и `inherit`
   * оставляет её — подменять рамку хода изнутри нельзя. До очереди и
   * после её освобождения область открывается по владельцу хода: это
   * тот же человек, просто работа идёт вне основного участка.
   */
  private scoped<T>(owner: TurnOwner, work: () => Promise<T>): Promise<T> {
    return this.db.withUserScope(
      owner.column === "user_id"
        ? { userId: owner.value, label: "turn.lifecycle", inherit: true }
        : { telegramId: owner.value, label: "turn.lifecycle", inherit: true },
      async () => await work(),
    );
  }

  /**
   * Начало хода. Возвращает handle даже при выключенном флаге и при
   * ошибке записи: вызывающий код не должен ветвиться на «а записалось
   * ли», иначе shadow-режим перестанет быть shadow.
   *
   * Повторная доставка того же события второй записи не создаёт: ключ
   * идемпотентности тот же, строка та же, растёт только номер попытки.
   */
  async start(input: TurnStartInput): Promise<TurnHandle> {
    const idempotencyKey = turnIdempotencyKey(input);
    const owner = ownerOf(input);
    const handle: TurnHandle = {
      runId: randomUUID(),
      idempotencyKey,
      duplicate: false,
      state: null,
      recorded: false,
      owner,
    };
    if (!this.enabled) return handle;
    if (!owner) {
      // Владельца нет — писать строку некуда: она осталась бы вне
      // границы арендатора. Отказ, а не запись «ничья».
      this.logger.warn("Ход не записан: владелец неизвестен", { idempotencyKey });
      return handle;
    }

    try {
      const { rows } = await this.scoped(owner, async () => await this.db.query<{
        run_id: string;
        state: string;
        inserted: boolean;
      }>(
        `INSERT INTO turn_runs (
           run_id, idempotency_key, channel, user_id, telegram_user_id,
           update_id, agent_id, conversation_id, purpose, trace_id,
           state, started_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accepted', now())
         ON CONFLICT (idempotency_key) DO UPDATE
           SET attempt = turn_runs.attempt + 1,
               updated_at = now()
         RETURNING run_id, state, (xmax = 0) AS inserted`,
        [
          handle.runId,
          idempotencyKey,
          input.channel,
          input.userId ?? null,
          input.telegramUserId ?? null,
          input.updateId ?? null,
          input.agentId ?? null,
          input.conversationId ?? null,
          input.purpose ?? null,
          input.traceId ?? null,
        ],
      ));
      const row = rows[0];
      if (row) {
        handle.runId = row.run_id;
        handle.duplicate = row.inserted === false;
        handle.state = isTurnState(row.state) ? row.state : null;
        handle.recorded = true;
        if (!handle.duplicate) {
          await this.db.query(
            `INSERT INTO turn_transitions (run_id, from_state, to_state, detail)
             VALUES ($1, NULL, 'accepted', '{}'::jsonb)`,
            [handle.runId],
          );
        }
      }
    } catch (error) {
      this.warn("Не удалось открыть запись хода", error, { idempotencyKey });
    }
    return handle;
  }

  /**
   * Переход состояния. Недопустимый переход отклоняется и логируется —
   * в shadow-режиме это диагностика, а не отказ обслуживания.
   */
  async transition(
    handle: TurnHandle,
    to: TurnState,
    options: { errorCode?: string | null; detail?: Record<string, unknown> } = {},
  ): Promise<boolean> {
    if (!this.enabled || !handle.recorded || !handle.owner) return false;
    const owner = handle.owner;
    try {
      return await this.scoped(owner, async () => await this.db.transaction(async (client) => {
        const { rows } = await client.query<{ state: string; attempt: number }>(
          `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
         -- значение сверяет граница арендатора в рантайме
         SELECT state, attempt FROM turn_runs
            WHERE run_id = $1 AND ${owner.column} = $2
            FOR UPDATE`,
          [handle.runId, owner.value],
        );
        const current = rows[0];
        if (!current) return false;
        const from = isTurnState(current.state) ? current.state : null;
        if (!canTransition(from, to)) {
          const rejected = new InvalidTurnTransitionError(from, to);
          this.logger.warn("Переход хода отклонён", {
            runId: handle.runId,
            from: current.state,
            to,
            code: rejected.code,
          });
          await client.query(
            `INSERT INTO turn_transitions (run_id, from_state, to_state, attempt, error_code, detail)
             VALUES ($1, $2, $3, $4, 'invalid_transition', '{"rejected": true}'::jsonb)`,
            [handle.runId, current.state, to, current.attempt],
          );
          return false;
        }

        const finished = TERMINAL_STATES.has(to);
        await client.query(
          `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
          -- значение сверяет граница арендатора в рантайме
          UPDATE turn_runs
              SET state = $3,
                  error_code = COALESCE($4, error_code),
                  updated_at = now(),
                  finished_at = CASE WHEN $5::boolean THEN now() ELSE finished_at END,
                  duration_ms = CASE
                    WHEN $5::boolean
                      THEN GREATEST(0, (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer)
                    ELSE duration_ms
                  END
            WHERE run_id = $1 AND ${owner.column} = $2`,
          [handle.runId, owner.value, to, options.errorCode ?? null, finished],
        );
        await client.query(
          `INSERT INTO turn_transitions (run_id, from_state, to_state, attempt, error_code, detail)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            handle.runId,
            current.state,
            to,
            current.attempt,
            options.errorCode ?? null,
            JSON.stringify(options.detail ?? {}),
          ],
        );
        handle.state = to;
        return true;
      }));
    } catch (error) {
      this.warn("Не удалось записать переход хода", error, {
        runId: handle.runId,
        to,
      });
      return false;
    }
  }

  /** Связи хода с уже существующими записями. Пишется по мере появления. */
  async link(handle: TurnHandle, links: TurnLinks): Promise<void> {
    if (!this.enabled || !handle.recorded || !handle.owner) return;
    const owner = handle.owner;
    const fields: Array<[string, unknown]> = [];
    const add = (column: string, value: unknown) => {
      if (value !== undefined) fields.push([column, value]);
    };
    add("user_id", links.userId);
    add("agent_id", links.agentId);
    add("conversation_id", links.conversationId);
    add("purpose", links.purpose);
    add("quota_metric", links.quotaMetric);
    add("quota_charged", links.quotaCharged);
    add("outbox_id", links.outboxId);
    add("llm_request_id", links.llmRequestId);
    add("letta_session_id", links.lettaSessionId);
    add("letta_run_ids", links.lettaRunIds);
    add("trace_id", links.traceId);
    add("prompt_version", links.promptVersion);
    add("flow_version", links.flowVersion);
    if (fields.length === 0) return;

    const values: unknown[] = [handle.runId, owner.value];
    const assignments = fields.map(([column, value]) => {
      values.push(value);
      return `${column} = COALESCE($${values.length}, ${column})`;
    });
    try {
      await this.scoped(owner, async () => await this.db.query(
        `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
          -- значение сверяет граница арендатора в рантайме
          UPDATE turn_runs SET ${assignments.join(", ")}, updated_at = now()
          WHERE run_id = $1 AND ${owner.column} = $2`,
        values,
      ));
    } catch (error) {
      this.warn("Не удалось связать ход с записями", error, { runId: handle.runId });
    }
  }

  /** Аренда исполнителя и номер попытки — для восстановления после перезапуска. */
  async lease(handle: TurnHandle, ownerName: string, seconds: number): Promise<void> {
    if (!this.enabled || !handle.recorded || !handle.owner) return;
    const owner = handle.owner;
    try {
      await this.scoped(owner, async () => await this.db.query(
        `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
          -- значение сверяет граница арендатора в рантайме
          UPDATE turn_runs
            SET lease_owner = $3,
                lease_expires_at = now() + make_interval(secs => $4),
                updated_at = now()
          WHERE run_id = $1 AND ${owner.column} = $2`,
        [handle.runId, owner.value, ownerName, Math.max(1, seconds)],
      ));
    } catch (error) {
      this.warn("Не удалось обновить аренду хода", error, { runId: handle.runId });
    }
  }

  /** Барьер отмены. Проверяется исполнителем перед следующим шагом. */
  async requestCancel(handle: TurnHandle, reason: string): Promise<void> {
    if (!this.enabled || !handle.recorded || !handle.owner) return;
    const owner = handle.owner;
    try {
      await this.scoped(owner, async () => await this.db.query(
        `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
          -- значение сверяет граница арендатора в рантайме
          UPDATE turn_runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                cancel_reason = COALESCE(cancel_reason, $3),
                updated_at = now()
          WHERE run_id = $1 AND ${owner.column} = $2`,
        [handle.runId, owner.value, reason.slice(0, 200)],
      ));
    } catch (error) {
      this.warn("Не удалось запросить отмену хода", error, { runId: handle.runId });
    }
  }

  async isCancelled(handle: TurnHandle): Promise<boolean> {
    if (!this.enabled || !handle.recorded || !handle.owner) return false;
    const owner = handle.owner;
    try {
      const { rows } = await this.scoped(owner, async () => await this.db.query<{
        cancelled: boolean;
      }>(
        `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
          -- значение сверяет граница арендатора в рантайме
          SELECT cancel_requested_at IS NOT NULL AS cancelled FROM turn_runs
          WHERE run_id = $1 AND ${owner.column} = $2`,
        [handle.runId, owner.value],
      ));
      return rows[0]?.cancelled === true;
    } catch (error) {
      this.warn("Не удалось прочитать барьер отмены", error, { runId: handle.runId });
      return false;
    }
  }

  /** Сколько ход ждал очереди до начала работы. */
  async recordWait(handle: TurnHandle, waitMs: number): Promise<void> {
    if (!this.enabled || !handle.recorded || !handle.owner) return;
    const owner = handle.owner;
    try {
      await this.scoped(owner, async () => await this.db.query(
        `-- tenant: by owner — столбец владельца хода подставляется ownerOf,
          -- значение сверяет граница арендатора в рантайме
          UPDATE turn_runs SET wait_ms = $3, updated_at = now()
          WHERE run_id = $1 AND ${owner.column} = $2`,
        [handle.runId, owner.value, Math.max(0, Math.round(waitMs))],
      ));
    } catch (error) {
      this.warn("Не удалось записать ожидание хода", error, { runId: handle.runId });
    }
  }

  /**
   * Ошибка наблюдения не должна выглядеть как ошибка хода и не должна
   * тащить наружу текст запроса: в лог уходит только код.
   */
  private warn(message: string, error: unknown, context: Record<string, unknown>): void {
    this.logger.warn(message, {
      ...context,
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
