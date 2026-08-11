/**
 * Восстановление: жизненный цикл ходов, попытки, отмена, побочные эффекты,
 * ручная сверка и безопасный повтор доставки.
 *
 * Всё, что здесь читается, уже существует и заводилось шагами 03–05:
 * `turn_runs`, `turn_transitions`, `turn_recovery_attempts`, `tool_effects`,
 * `telegram_outbox`. Ни одной новой таблицы этот раздел не заводит — он
 * отвечает на вопросы дежурного по тем же строкам, по которым работает
 * автоматическое восстановление.
 *
 * Два действия и обе их границы:
 *
 *   отмена хода     — ставит барьер отмены, а не переводит состояние руками.
 *                     Состояния меняет владелец хода: чужой UPDATE состояния
 *                     из админки разошёлся бы с его собственным переходом;
 *   повтор доставки — возвращает в очередь только то, что заведомо не
 *                     ушло. Строка со `sent_at` не повторяется никогда:
 *                     цена ошибки здесь — второе сообщение человеку,
 *                     которого он не ждал.
 *
 * Содержимого сообщений в ответах нет: `telegram_outbox.payload` не
 * читается ни одним запросом этого модуля.
 */

import { badRequest, notFound } from "../errors.js";
import { isTurnState, TERMINAL_STATES } from "../turns/states.js";

export interface TurnOperationsDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface TurnFilter {
  state?: string;
  userId?: number;
  active?: boolean;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Сколько ход может стоять в нетерминальном состоянии, прежде чем это повод. */
const STUCK_MINUTES = 15;

function runId(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(text)) throw badRequest("Некорректный идентификатор хода");
  return text;
}

function bounded(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 0), max);
}

export class TurnOperationsService {
  constructor(private readonly db: TurnOperationsDatabase) {}

  /** Ходы по состоянию и возрасту. Основной экран дежурного. */
  async turns(filter: TurnFilter): Promise<{ turns: Record<string, unknown>[]; total: number }> {
    const state = filter.state ? String(filter.state) : null;
    if (state !== null && !isTurnState(state)) throw badRequest("Неизвестное состояние хода");
    const limit = bounded(filter.limit, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = bounded(filter.offset, 0, 100_000);

    const { rows } = await this.db.query(
      `-- tenant: system — экран дежурного по ходам всей установки; область администратора объявлена маршрутом и записана в аудит
       SELECT run_id, user_id, channel, agent_id, conversation_id, purpose, state,
              attempt, lease_owner, lease_expires_at, cancel_requested_at, cancel_reason,
              error_code, created_at, started_at, finished_at, duration_ms,
              count(*) OVER () AS total
         FROM turn_runs
        WHERE ($1::text IS NULL OR state = $1)
          AND ($2::bigint IS NULL OR user_id = $2)
          AND ($3::boolean IS NULL OR ($3 AND finished_at IS NULL)
                                   OR (NOT $3 AND finished_at IS NOT NULL))
        ORDER BY created_at DESC
        LIMIT $4 OFFSET $5`,
      [
        state,
        filter.userId ?? null,
        filter.active === undefined ? null : filter.active,
        limit,
        offset,
      ],
    );
    return {
      turns: rows.map(toTurn),
      total: rows.length > 0 ? Number(rows[0]!.total ?? rows.length) : 0,
    };
  }

  /** Карточка хода: переходы, попытки восстановления, эффекты, доставка. */
  async turn(id: string): Promise<Record<string, unknown>> {
    const run = runId(id);
    const { rows } = await this.db.query(
      `-- tenant: system — карточка чужого хода в административной панели; область администратора объявлена маршрутом и записана в аудит
       SELECT run_id, user_id, channel, agent_id, conversation_id, purpose, state,
              attempt, lease_owner, lease_expires_at, cancel_requested_at, cancel_reason,
              error_code, created_at, started_at, finished_at, duration_ms, outbox_id
         FROM turn_runs
        WHERE run_id = $1`,
      [run],
    );
    if (rows.length === 0) throw notFound(`ход ${run} не найден`);

    const [transitions, attempts, effects, deliveries] = await Promise.all([
      this.db.query(
        // tenant: system — журнал переходов хода без содержания разговора;
        // область администратора объявлена маршрутом и записана в аудит
        `SELECT from_state, to_state, attempt, error_code, detail, at
           FROM turn_transitions
          WHERE run_id = $1
          ORDER BY at, id
          LIMIT 200`,
        [run],
      ),
      this.db.query(
        `-- tenant: system — попытки восстановления одного хода в административной карточке; область администратора объявлена маршрутом и записана в аудит
         SELECT reason, found_state, decision, outcome, detail, at
           FROM turn_recovery_attempts
          WHERE run_id = $1
          ORDER BY at, id
          LIMIT 100`,
        [run],
      ),
      this.db.query(
        // Значения результата не читаются: у эффекта есть и сырое значение,
        // и его хэш, и в административный ответ не идёт ни то, ни другое.
        `-- tenant: system — журнал побочных эффектов одного хода; область администратора объявлена маршрутом и записана в аудит
         SELECT effect_key, tool_name, tool_call_id, status, attempt, created_at
           FROM tool_effects
          WHERE run_id = $1
          ORDER BY created_at
          LIMIT 200`,
        [run],
      ),
      this.db.query(
        // payload не читается намеренно: это текст ответа человеку.
        `-- tenant: system — доставка, привязанная к разбираемому ходу; область администратора объявлена маршрутом и записана в аудит
         SELECT id, user_id, status, attempts, telegram_method, available_at,
                sent_at, last_error, created_at
           FROM telegram_outbox
          WHERE id = $1
          ORDER BY id`,
        [rows[0]!.outbox_id ?? null],
      ),
    ]);

    return {
      turn: toTurn(rows[0]!),
      transitions: transitions.rows,
      recovery_attempts: attempts.rows,
      effects: effects.rows,
      deliveries: deliveries.rows,
    };
  }

  /**
   * Барьер отмены.
   *
   * Состояние здесь не переписывается: отмену исполняет тот, кто ведёт ход,
   * и делает это своим переходом. Административный UPDATE состояния означал
   * бы двух писателей одного жизненного цикла.
   */
  async requestCancel(id: string, reason: string): Promise<Record<string, unknown>> {
    const run = runId(id);
    if (!reason.trim()) throw badRequest("Отмена требует причины");
    const { rows } = await this.db.query(
      `-- tenant: system — административная отмена чужого хода по его идентификатору; область администратора объявлена маршрутом и записана в аудит
       UPDATE turn_runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
              cancel_reason = COALESCE(cancel_reason, $2),
              updated_at = now()
        WHERE run_id = $1
          AND state <> ALL ($3::text[])
        RETURNING run_id, user_id, state, cancel_requested_at, cancel_reason`,
      [run, reason.slice(0, 200), [...TERMINAL_STATES]],
    );
    if (rows.length === 0) {
      throw badRequest("Ход уже закончился: отменять нечего");
    }
    return rows[0]!;
  }

  /**
   * Ручная сверка: что застряло прямо сейчас.
   *
   * Ничего не чинит — как и автоматические сверки обслуживания. Отчёт
   * называет число застрявших по каждому виду и не показывает ни одной
   * строки пользовательских данных.
   */
  async reconcile(): Promise<Record<string, unknown>> {
    const { rows: turns } = await this.db.query(
      `-- tenant: system — сводка застрявших ходов по установке целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT state, count(*) AS stuck, min(updated_at) AS oldest
         FROM turn_runs
        WHERE finished_at IS NULL
          AND state <> ALL ($1::text[])
          AND updated_at < now() - make_interval(mins => $2::int)
        GROUP BY state
        ORDER BY state`,
      [[...TERMINAL_STATES], STUCK_MINUTES],
    );
    const { rows: outbox } = await this.db.query(
      `-- tenant: system — сводка доставки по установке целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT status, count(*) AS rows_count, min(created_at) AS oldest
         FROM telegram_outbox
        WHERE status IN ('pending', 'sending', 'retry', 'dead')
        GROUP BY status
        ORDER BY status`,
    );
    const { rows: effects } = await this.db.query(
      `-- tenant: system — незакрытые эффекты по установке целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT count(*) AS running, min(created_at) AS oldest
         FROM tool_effects
        WHERE status = 'running'
          AND created_at < now() - make_interval(mins => $1::int)`,
      [STUCK_MINUTES],
    );
    const { rows: leases } = await this.db.query(
      `-- tenant: system — счётчик истёкших аренд по установке целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT count(*) AS expired
         FROM turn_runs
        WHERE finished_at IS NULL
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at < now()`,
    );

    return {
      threshold_minutes: STUCK_MINUTES,
      turns_by_state: turns,
      outbox_by_status: outbox,
      running_effects: effects[0] ?? { running: 0, oldest: null },
      expired_leases: Number(leases[0]?.expired ?? 0),
      note: "Сверка ничего не чинит: она показывает, что застряло.",
    };
  }

  /**
   * Безопасный повтор доставки.
   *
   * Повторяется только то, что заведомо не ушло: `dead` или `retry` без
   * отметки об отправке. Строка со `sent_at` не повторяется никогда —
   * второе сообщение человеку хуже, чем неотправленное первое.
   */
  async redeliver(outboxId: number): Promise<Record<string, unknown>> {
    if (!Number.isInteger(outboxId) || outboxId <= 0) {
      throw badRequest("Некорректный идентификатор доставки");
    }
    const { rows: existing } = await this.db.query(
      `-- tenant: system — проверка одной строки доставки перед повтором; область администратора объявлена маршрутом и записана в аудит
       SELECT id, user_id, status, sent_at, attempts
         FROM telegram_outbox
        WHERE id = $1`,
      [outboxId],
    );
    if (existing.length === 0) throw notFound(`доставка ${outboxId} не найдена`);
    const row = existing[0]!;
    if (row.sent_at !== null && row.sent_at !== undefined) {
      throw badRequest("Сообщение уже доставлено: повтор создал бы второе");
    }
    if (row.status !== "dead" && row.status !== "retry") {
      throw badRequest(`Повторяется только dead или retry, а строка в состоянии ${String(row.status)}`);
    }

    const { rows } = await this.db.query(
      `-- tenant: system — административный повтор одной строки доставки; область администратора объявлена маршрутом и записана в аудит
       UPDATE telegram_outbox
          SET status = 'pending',
              available_at = now(),
              locked_at = NULL,
              locked_by = NULL,
              updated_at = now()
        WHERE id = $1
          AND sent_at IS NULL
          AND status IN ('dead', 'retry')
        RETURNING id, user_id, status, attempts, available_at`,
      [outboxId],
    );
    if (rows.length === 0) {
      // Между чтением и записью строку могли отправить.
      throw badRequest("Состояние доставки изменилось: повтор отменён");
    }
    return rows[0]!;
  }
}

function toTurn(row: Record<string, unknown>): Record<string, unknown> {
  const { total: _total, outbox_id: _outboxId, ...rest } = row;
  return rest;
}
