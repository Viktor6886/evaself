/**
 * Восстановление незавершённого хода.
 *
 * Процесс упал посреди хода. Запись в `turn_runs` осталась с истёкшей
 * арендой, и вопрос ровно один: что уже случилось, а что нет. Ответ на
 * него нельзя угадать — его надо собрать из следов, которые ход оставил
 * по дороге: строка outbox, факт отправки, состояние у Letta, журнал
 * побочных эффектов.
 *
 * Правило, из которого всё следует: **повторять ход можно только при
 * доказанном отсутствии завершённого**. Не «при отсутствии
 * доказательств завершения», а наоборот. Сомнение — довод против
 * повтора: лишний ответ и второй побочный эффект человек видит, а
 * недоставленный ответ он хотя бы может попросить снова.
 *
 * Каждая попытка оставляет запись: причина, найденное состояние,
 * решение и результат. Без неё разбор инцидента упирается в догадки —
 * `turn_runs` показывает итог, но не показывает, на каком основании он
 * выбран.
 */

import type { Database } from "../db.js";
import type { Logger } from "../logger.js";
import type { EffectJournal } from "./effect-journal.js";
import { isTurnState, TERMINAL_STATES, type TurnState } from "./states.js";

/** Что нашли про ход. Только факты, без интерпретации. */
export interface TurnEvidence {
  runId: string;
  userId: number | null;
  state: TurnState | null;
  attempt: number;
  outboxId: string | null;
  /** Строка outbox существует и уже отправлена. */
  delivered: boolean;
  /** Строка outbox существует и ещё ждёт отправки. */
  outboxPending: boolean;
  conversationId: string | null;
  /** Побочные эффекты хода: сколько успешных и сколько незакрытых. */
  effects: { running: number; succeeded: number; failed: number };
}

/**
 * Решение о ходе.
 *
 * `wait` — ход жив и продолжается где-то ещё; `deliver` — результат
 * готов, не хватает только доставки; `retry` — доказано, что
 * завершённого хода не было; `abandon` — повтор небезопасен.
 */
export type RecoveryDecision = "wait" | "deliver" | "retry" | "abandon";

export interface RecoveryOutcome {
  runId: string;
  decision: RecoveryDecision;
  reason: string;
}

export interface RecoveryOptions {
  /** Через сколько секунд после истечения аренды ход считается брошенным. */
  staleAfterSeconds: number;
  /** Сколько ходов разбирать за один заход. */
  batchSize: number;
  /** Сколько попыток восстановления допустимо на один ход. */
  maxAttempts: number;
}

export const RECOVERY_DEFAULTS: RecoveryOptions = {
  staleAfterSeconds: 60,
  batchSize: 20,
  maxAttempts: 3,
};

interface StaleRow {
  run_id: string;
  user_id: string | null;
  state: string;
  attempt: number;
  outbox_id: string | null;
  conversation_id: string | null;
  lease_owner: string | null;
  cancel_requested_at: Date | null;
}

export class TurnRecoveryService {
  private readonly options: RecoveryOptions;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly effects: EffectJournal,
    private readonly enabled: boolean,
    options: Partial<RecoveryOptions> = {},
  ) {
    this.options = { ...RECOVERY_DEFAULTS, ...options };
  }

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Один заход: найти брошенные ходы и решить по каждому.
   *
   * Сам повтор здесь не выполняется. Восстановление отвечает на вопрос
   * «что делать», а делает это тот, у кого есть ход, — иначе решение и
   * исполнение оказались бы в одном месте, и проверить решение было бы
   * нечем.
   */
  async sweep(): Promise<RecoveryOutcome[]> {
    if (!this.enabled) return [];
    try {
      const stale = await this.findStale();
      const outcomes: RecoveryOutcome[] = [];
      for (const row of stale) {
        const evidence = await this.collect(row);
        const { decision, reason } = this.decide(row, evidence);
        await this.record(evidence, decision, reason);
        await this.apply(evidence, decision);
        outcomes.push({ runId: evidence.runId, decision, reason });
      }
      if (outcomes.length > 0) {
        this.logger.info("Восстановление разобрало брошенные ходы", {
          count: outcomes.length,
          decisions: outcomes.reduce<Record<string, number>>((acc, item) => {
            acc[item.decision] = (acc[item.decision] ?? 0) + 1;
            return acc;
          }, {}),
        });
      }
      return outcomes;
    } catch (error) {
      this.logger.error("Заход восстановления не удался", {
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Ходы с истёкшей арендой, не дошедшие до терминального состояния. */
  private async findStale(): Promise<StaleRow[]> {
    return await this.db.withSystemScope(
      "turns.recovery.scan",
      async () => {
        const { rows } = await this.db.query<StaleRow>(
          `
            -- tenant: system — восстановление разбирает брошенные ходы всех пользователей: строки берутся по истёкшей аренде, а не по запросу человека
            SELECT run_id, user_id, state, attempt, outbox_id, conversation_id,
                   lease_owner, cancel_requested_at
              FROM turn_runs
             WHERE finished_at IS NULL
               AND state NOT IN ('completed', 'cancelled', 'failed_terminal')
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at < now() - make_interval(secs => $1)
               AND attempt <= $3
             ORDER BY updated_at
             LIMIT $2`,
          [this.options.staleAfterSeconds, this.options.batchSize, this.options.maxAttempts],
        );
        return rows;
      },
      { crossUser: true },
    );
  }

  /** Собрать следы хода. Ничего не решает — только смотрит. */
  private async collect(row: StaleRow): Promise<TurnEvidence> {
    const userId = row.user_id === null ? null : Number(row.user_id);
    const evidence: TurnEvidence = {
      runId: row.run_id,
      userId,
      state: isTurnState(row.state) ? row.state : null,
      attempt: row.attempt,
      outboxId: row.outbox_id,
      delivered: false,
      outboxPending: false,
      conversationId: row.conversation_id,
      effects: { running: 0, succeeded: 0, failed: 0 },
    };

    if (row.outbox_id) {
      const { rows } = await this.db.withSystemScope(
        "turns.recovery.outbox",
        async () => await this.db.query<{ status: string }>(
          `
            -- tenant: system — восстановление смотрит доставку брошенного хода по идентификатору строки outbox, а не по запросу человека
            SELECT status FROM telegram_outbox WHERE id = $1`,
          [row.outbox_id],
        ),
        { crossUser: true },
      );
      const status = rows[0]?.status ?? null;
      evidence.delivered = status === "sent";
      evidence.outboxPending = status !== null && status !== "sent" && status !== "dead";
    }

    if (userId !== null) {
      evidence.effects = await this.db.withUserScope(
        { userId, label: "turns.recovery.effects" },
        async () => await this.effects.summary(row.run_id, userId),
      );
    }
    return evidence;
  }

  /**
   * Решение по собранному.
   *
   * Порядок проверок — это порядок убывания опасности. Сначала то, что
   * запрещает трогать ход вовсе, и только в конце — повтор.
   */
  private decide(
    row: StaleRow,
    evidence: TurnEvidence,
  ): { decision: RecoveryDecision; reason: string } {
    if (row.cancel_requested_at !== null) {
      return { decision: "abandon", reason: "ход отменён до сбоя" };
    }
    if (evidence.state !== null && TERMINAL_STATES.has(evidence.state)) {
      return { decision: "abandon", reason: "ход уже завершён" };
    }
    if (evidence.delivered) {
      // Ответ дошёл до человека. Повтор здесь — второй ответ на одно
      // сообщение, и никакая экономия этого не оправдывает.
      return { decision: "abandon", reason: "ответ уже доставлен" };
    }
    if (evidence.outboxPending) {
      // Результат есть, доставка ещё идёт своим чередом: outbox доведёт
      // её сам, обращаться к модели незачем.
      return { decision: "deliver", reason: "результат в outbox, доставка продолжится" };
    }
    if (evidence.state === "result_received" || evidence.state === "outbox_committed") {
      return { decision: "deliver", reason: "результат получен, не хватает доставки" };
    }
    if (evidence.effects.running > 0) {
      // Незакрытый побочный эффект означает, что мы не знаем, случился
      // он или нет. Повтор мог бы сделать его вторым.
      return { decision: "wait", reason: "есть незакрытый побочный эффект" };
    }
    if (evidence.attempt >= this.options.maxAttempts) {
      return { decision: "abandon", reason: "попытки восстановления исчерпаны" };
    }
    if (evidence.effects.succeeded > 0) {
      // Побочные эффекты уже случились, но ответа не было. Повтор
      // безопасен ровно потому, что журнал вернёт прежние результаты
      // вместо повторного выполнения.
      return {
        decision: "retry",
        reason: "завершённого хода не было, эффекты защищены журналом",
      };
    }
    return { decision: "retry", reason: "завершённого хода не было" };
  }

  /** Применить решение к записи хода. Повтор возвращает ход в очередь. */
  private async apply(evidence: TurnEvidence, decision: RecoveryDecision): Promise<void> {
    const next: Record<RecoveryDecision, TurnState | null> = {
      wait: null,
      deliver: "delivering",
      retry: "queued",
      abandon: "failed_terminal",
    };
    const target = next[decision];
    if (target === null) return;
    await this.db.withSystemScope(
      "turns.recovery.apply",
      async () => await this.db.query(
        `
          -- tenant: system — восстановление правит собственную запись брошенного хода, найденную по истёкшей аренде
          UPDATE turn_runs
             SET state = $2,
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 updated_at = now(),
                 finished_at = CASE WHEN $3::boolean THEN now() ELSE finished_at END,
                 error_code = CASE WHEN $3::boolean THEN COALESCE(error_code, 'recovery_abandoned')
                                   ELSE error_code END
           WHERE run_id = $1`,
        [evidence.runId, target, target === "failed_terminal"],
      ),
      { crossUser: true },
    );
  }

  /** Каждая попытка — отдельная запись. Пользовательского текста в ней нет. */
  private async record(
    evidence: TurnEvidence,
    decision: RecoveryDecision,
    reason: string,
  ): Promise<void> {
    const found = [
      `state=${evidence.state ?? "unknown"}`,
      `outbox=${evidence.delivered ? "sent" : evidence.outboxPending ? "pending" : "none"}`,
      `effects=${evidence.effects.succeeded}/${evidence.effects.running}`,
    ].join(" ");
    try {
      await this.db.withSystemScope(
        "turns.recovery.record",
        async () => await this.db.query(
          `
            -- tenant: system — журнал восстановления пишется по брошенному ходу, найденному по истёкшей аренде, а не по запросу человека
            INSERT INTO turn_recovery_attempts
              (run_id, user_id, reason, found_state, decision, outcome, detail)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            evidence.runId,
            evidence.userId,
            "lease_expired",
            found,
            decision,
            reason,
            JSON.stringify({
              attempt: evidence.attempt,
              effects: evidence.effects,
              delivered: evidence.delivered,
            }),
          ],
        ),
        { crossUser: true },
      );
    } catch (error) {
      this.logger.warn("Не удалось записать попытку восстановления", {
        runId: evidence.runId,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}
