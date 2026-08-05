/**
 * Журнал побочных эффектов инструментов.
 *
 * Ход можно переиграть. Отправленное сообщение, созданную задачу и
 * списанную квоту переиграть нельзя. Между этими двумя фактами и живёт
 * этот журнал: перед выполнением инструмента заводится запись с
 * детерминированным ключом, и повтор с тем же ключом действие не
 * выполняет, а возвращает прежний результат.
 *
 * Ключ выводится из того, что при повторе хода не меняется: `run_id`,
 * идентификатор вызова инструмента и его имя. Аргументы в ключ не
 * входят намеренно — они могут содержать пользовательский текст, а ключ
 * лежит в базе открытым.
 *
 * Что попадает в `result`: только то, что заведомо безопасно —
 * идентификаторы, счётчики, флаги. Всё остальное сводится к хэшу:
 * повторный вызов должен узнать «это уже делалось и вот с каким
 * итогом», а не пересказать содержание разговора.
 */

import { createHash } from "node:crypto";

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

/** Что делать с вызовом инструмента. */
export type EffectDecision =
  /** Выполнять: записи не было. */
  | { action: "execute"; attempt: number }
  /** Не выполнять: результат уже есть, вернуть его. */
  | { action: "replay"; result: unknown }
  /** Не выполнять: тот же вызов идёт прямо сейчас или отказ неповторяем. */
  | { action: "skip"; reason: "in_flight" | "not_retryable"; errorCode: string | null };

export interface EffectOutcome {
  /** Безопасное значение целиком. Взаимоисключимо с `hash`. */
  result?: unknown;
  /** Хэш небезопасного значения: факт есть, содержания нет. */
  hash?: string;
}

/** Значения, которые можно положить в журнал как есть. */
function safeResult(value: unknown): EffectOutcome {
  if (value === null || value === undefined) return { result: null };
  if (typeof value === "number" || typeof value === "boolean") return { result: value };
  if (typeof value === "object") {
    // Объект берётся целиком только если в нём нет строк: строка от
    // инструмента — это чаще всего пересказ пользовательских данных.
    const flat = Object.values(value as Record<string, unknown>);
    const plain = flat.every(
      (item) => item === null || typeof item === "number" || typeof item === "boolean",
    );
    if (plain) return { result: value };
  }
  return { hash: createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex") };
}

/**
 * Ключ исполнения.
 *
 * `toolCallId` даёт SDK, и при повторной отправке того же хода он тот
 * же. Если его нет — ключ строится из имени и порядкового номера
 * вызова: хуже, чем идентификатор, но лучше, чем ничего.
 */
export function effectKey(runId: string, toolCallId: string, toolName: string): string {
  return `${runId}:${toolCallId}:${toolName}`;
}

export class EffectJournal {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly enabled: boolean,
  ) {}

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Область арендатора для записей журнала.
   *
   * `tool_effects` — пользовательская таблица, и обращение к ней вне
   * области не выполняется. Внутри хода область уже объявлена, и
   * `inherit` её оставляет; собственную журнал открывает там, где его
   * зовут не из хода — например восстановление.
   */
  private scoped<T>(userId: number, work: () => Promise<T>): Promise<T> {
    return this.db.withUserScope(
      { userId, label: "tool.effects", inherit: true },
      async () => await work(),
    );
  }

  /**
   * Открыть запись перед выполнением.
   *
   * Отказ журнала не должен превращаться в отказ инструмента: если
   * запись открыть не удалось, вызов выполняется как раньше. Это
   * осознанный размен — потерять защиту от повтора хуже, чем потерять
   * действие, но отказать в действии из-за журнала ещё хуже.
   */
  async begin(input: {
    key: string;
    runId: string;
    userId: number | null;
    toolName: string;
    toolCallId: string;
  }): Promise<EffectDecision> {
    if (!this.enabled) return { action: "execute", attempt: 1 };
    if (input.userId === null) {
      // Без владельца строку некуда положить: она осталась бы вне
      // границы арендатора. Инструмент при этом выполняется — отказать
      // в действии из-за журнала хуже, чем потерять защиту от повтора.
      this.logger.warn("Эффект не записан: владелец неизвестен", { tool: input.toolName });
      return { action: "execute", attempt: 1 };
    }
    const owner = input.userId;
    try {
      const { rows } = await this.scoped(owner, async () => await this.db.query<{
        status: string;
        attempt: number;
        result: unknown;
        result_hash: string | null;
        error_code: string | null;
        retryable: boolean;
        inserted: boolean;
      }>(
        `INSERT INTO tool_effects (effect_key, run_id, user_id, tool_name, tool_call_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (effect_key) DO UPDATE
           SET attempt = CASE
                 WHEN tool_effects.status = 'failed' AND tool_effects.retryable
                   THEN tool_effects.attempt + 1
                 ELSE tool_effects.attempt
               END,
               status = CASE
                 WHEN tool_effects.status = 'failed' AND tool_effects.retryable
                   THEN 'running'
                 ELSE tool_effects.status
               END,
               updated_at = now()
         RETURNING status, attempt, result, result_hash, error_code, retryable,
                   (xmax = 0) AS inserted`,
        [input.key, input.runId, input.userId, input.toolName, input.toolCallId],
      ));
      const row = rows[0];
      if (!row) return { action: "execute", attempt: 1 };
      if (row.inserted) return { action: "execute", attempt: 1 };
      if (row.status === "succeeded") {
        return { action: "replay", result: row.result ?? { ok: true, replayed: true } };
      }
      if (row.status === "running" && row.attempt === 1) {
        // Тот же вызов уже идёт. Повторять нельзя: два действия там, где
        // ожидается одно, — это ровно то, ради чего журнал и заведён.
        return { action: "skip", reason: "in_flight", errorCode: null };
      }
      if (row.status === "failed") {
        return { action: "skip", reason: "not_retryable", errorCode: row.error_code };
      }
      return { action: "execute", attempt: row.attempt };
    } catch (error) {
      this.warn("Не удалось открыть запись эффекта", error, { tool: input.toolName });
      return { action: "execute", attempt: 1 };
    }
  }

  /**
   * Закрыть запись успехом. Результат сводится к безопасному виду, а
   * владелец называется в запросе: строка пользовательская, и адресовать
   * её одним ключом граница арендатора не даст — справедливо, потому
   * что чужой ключ тогда правился бы из чужой области.
   */
  async succeed(key: string, userId: number, value: unknown): Promise<void> {
    if (!this.enabled) return;
    const outcome = safeResult(value);
    try {
      await this.scoped(userId, async () => await this.db.query(
        `UPDATE tool_effects
            SET status = 'succeeded',
                result = $3::jsonb,
                result_hash = $4,
                error_code = NULL,
                updated_at = now(),
                completed_at = now()
          WHERE effect_key = $1 AND user_id = $2`,
        [
          key,
          userId,
          outcome.result === undefined ? null : JSON.stringify(outcome.result),
          outcome.hash ?? null,
        ],
      ));
    } catch (error) {
      this.warn("Не удалось закрыть запись эффекта", error, { key });
    }
  }

  /** Закрыть запись отказом. `retryable` задаёт индивидуальную политику вызова. */
  async fail(key: string, userId: number, errorCode: string, retryable: boolean): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.scoped(userId, async () => await this.db.query(
        `UPDATE tool_effects
            SET status = 'failed',
                error_code = $3,
                retryable = $4,
                updated_at = now(),
                completed_at = now()
          WHERE effect_key = $1 AND user_id = $2`,
        [key, userId, errorCode.slice(0, 200), retryable],
      ));
    } catch (error) {
      this.warn("Не удалось записать отказ эффекта", error, { key });
    }
  }

  /** Сколько эффектов у хода и чем кончились. Нужно восстановлению. */
  async summary(
    runId: string,
    userId: number,
  ): Promise<{ running: number; succeeded: number; failed: number }> {
    const empty = { running: 0, succeeded: 0, failed: 0 };
    if (!this.enabled) return empty;
    try {
      const { rows } = await this.scoped(userId, async () =>
        await this.db.query<{ status: string; count: string }>(
        `SELECT status, count(*) AS count FROM tool_effects
          WHERE run_id = $1 AND user_id = $2
          GROUP BY status`,
        [runId, userId],
      ));
      const result = { ...empty };
      for (const row of rows) {
        if (row.status === "running") result.running = Number(row.count);
        if (row.status === "succeeded") result.succeeded = Number(row.count);
        if (row.status === "failed") result.failed = Number(row.count);
      }
      return result;
    } catch (error) {
      this.warn("Не удалось прочитать сводку эффектов", error, { runId });
      return empty;
    }
  }

  private warn(message: string, error: unknown, context: Record<string, unknown>): void {
    this.logger.warn(message, {
      ...context,
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
