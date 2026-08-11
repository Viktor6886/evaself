/**
 * Проактивные сообщения на очередях.
 *
 * Отвечает на три вопроса и ни на один больше: кого сегодня уместно
 * побеспокоить, не писали ли мы ему это уже, и куда отдать готовый
 * текст. Сам текст сочиняет composer, доставку делает durable outbox —
 * воркер не отправляет в Telegram ничего напрямую (требование 9 шага 8),
 * и структурно не может: клиента Telegram у него нет.
 *
 * Идемпотентность двойная, и это не перестраховка. Строка
 * `proactive_messages` c уникальным слотом ловит повторный запуск
 * задания; ключ идемпотентности outbox ловит гонку двух реплик, успевших
 * занять слот и упасть между занятием и доставкой. Первого достаточно
 * при нормальной работе, второе нужно ровно тогда, когда работа не
 * нормальная.
 *
 * Решение «не писать» записывается так же, как «написать». Без записи
 * отказа следующий заход не отличит «сегодня уже подумали и промолчали»
 * от «ещё не думали».
 */

import type { Database } from "../../db.js";
import type { Logger } from "../../logger.js";
import {
  type ProactiveContext,
  type ProactiveKind,
  type ProactiveSkipReason,
  decideProactive,
  proactiveSlot,
} from "./policy.js";

/** Кандидат на проактивное сообщение: всё, что нужно решению. */
export interface ProactiveCandidate {
  userId: number;
  telegramId: number;
  chatId: number;
  agentId: string;
  conversationId: string;
  timezone: string;
  lastUserMessageAt: Date | null;
  lastProactiveAt: Date | null;
  unansweredProactive: number;
  consent: boolean;
  frequency: "normal" | "reduced" | "off";
  awaitingReply: boolean;
}

/** Кто сочиняет текст. В production — ход агента в conversation назначения `scheduler`. */
export interface ProactiveComposer {
  compose(input: {
    kind: ProactiveKind;
    candidate: ProactiveCandidate;
    /** Ссылка на предыдущий эпизод: вечер знает про утро, утро — про вечер. */
    episode: EpisodeLink | null;
    signal: AbortSignal;
  }): Promise<{ text: string | null }>;
}

/** Куда отдать готовый текст. Только durable outbox. */
export interface ProactiveDelivery {
  deliver(input: {
    userId: number;
    chatId: number;
    text: string;
    idempotencyKey: string;
  }): Promise<{ outboxId: string | null }>;
}

export interface EpisodeLink {
  episodeId: string;
  localDate: string;
  morningIntentRef: string | null;
  eveningOutcomeRef: string | null;
  previousLocalDate: string | null;
  previousEveningOutcomeRef: string | null;
}

export type ProactiveOutcome =
  | { status: "sent"; outboxId: string | null }
  | { status: "skipped"; reason: ProactiveSkipReason | "duplicate" | "empty_message" }
  | { status: "failed"; code: string };

/**
 * Через сколько занятый, но незавершённый слот считается брошенным.
 * Больше самого долгого хода агента и меньше интервала расписания:
 * иначе перехват случался бы посреди работы живого воркера.
 */
const STALE_CLAIM_SECONDS = 600;

export class ProactiveService {
  constructor(
    private readonly db: Database,
    private readonly composer: ProactiveComposer,
    private readonly delivery: ProactiveDelivery,
    private readonly logger: Logger,
  ) {}

  /**
   * Обработать одного кандидата.
   *
   * Порядок: решение → занятие слота → текст → доставка. Слот занимается
   * ДО обращения к модели: ход агента стоит денег и времени, и два
   * воркера, одновременно решившие написать, не должны оба его платить.
   */
  async handle(
    kind: ProactiveKind,
    candidate: ProactiveCandidate,
    options: { now?: Date; runId?: string; signal?: AbortSignal } = {},
  ): Promise<ProactiveOutcome> {
    const now = options.now ?? new Date();
    const signal = options.signal ?? new AbortController().signal;
    const slot = proactiveSlot(kind, candidate.timezone, now);
    const context: ProactiveContext = {
      timezone: candidate.timezone,
      lastUserMessageAt: candidate.lastUserMessageAt,
      lastProactiveAt: candidate.lastProactiveAt,
      unansweredProactive: candidate.unansweredProactive,
      consent: candidate.consent,
      frequency: candidate.frequency,
      awaitingReply: candidate.awaitingReply,
    };

    const decision = decideProactive(kind, context, now);
    if (!decision.send) {
      await this.record(kind, candidate, slot, "skipped", {
        reason: decision.reason,
        runId: options.runId,
      });
      return { status: "skipped", reason: decision.reason };
    }

    const claimed = await this.claimSlot(kind, candidate, slot, options.runId);
    if (!claimed) return { status: "skipped", reason: "duplicate" };

    try {
      const episode = kind === "checkin_morning" || kind === "checkin_evening"
        ? await this.ensureEpisode(candidate, slot.localDate, slot.timezone)
        : null;
      const composed = await this.composer.compose({ kind, candidate, episode, signal });
      const text = composed.text?.trim() ?? "";
      if (!text) {
        // «Ничего не отправлять» — валидный успешный исход (требование 8
        // шага 8): heartbeat без повода обязан уметь промолчать.
        await this.finish(claimed, "skipped", "empty_message", null);
        return { status: "skipped", reason: "empty_message" };
      }
      const delivered = await this.delivery.deliver({
        userId: candidate.userId,
        chatId: candidate.chatId,
        text,
        // Ключ идемпотентности доставки повторяет слот: даже если строка
        // слота будет занята дважды, outbox отправит одно сообщение.
        idempotencyKey: `proactive:${kind}:${candidate.userId}:${slot.slotKey}`,
      });
      await this.finish(claimed, "sent", null, delivered.outboxId);
      if (episode) await this.linkEpisode(kind, candidate.userId, episode, claimed);
      return { status: "sent", outboxId: delivered.outboxId };
    } catch (error) {
      const code = error instanceof Error ? error.name : "unknown_error";
      await this.finish(claimed, "failed", code, null);
      this.logger.warn("Проактивное сообщение не отправлено", { kind, code });
      return { status: "failed", code };
    }
  }

  /**
   * Занять слот.
   *
   * Уникальный слот делает повторный запуск задания безопасным: строка
   * достаётся тому, кто успел первым, остальные уходят ни с чем.
   *
   * Но «слот занят» и «сообщение отправлено» — разные вещи. Процесс,
   * упавший между занятием слота и доставкой, оставляет строку в
   * состоянии `planned` — и без перехвата напоминание пропало бы
   * навсегда: слот занят, а сообщения нет. Поэтому зависшая попытка
   * старше `STALE_CLAIM` забирается заново. Свежий `planned` не
   * трогается: он означает, что прямо сейчас работает другая реплика.
   */
  private async claimSlot(
    kind: ProactiveKind,
    candidate: ProactiveCandidate,
    slot: { slotKey: string; localDate: string; timezone: string },
    runId?: string,
  ): Promise<string | null> {
    const { rows } = await this.db.withUserScope(
      { userId: candidate.userId, label: "proactive.claim", inherit: true },
      async () => await this.db.query<{ id: string }>(
        `INSERT INTO proactive_messages
           (user_id, kind, slot_key, local_date, timezone, status, run_id)
         VALUES ($1, $2, $3, $4::date, $5, 'planned', $6)
         ON CONFLICT (user_id, kind, slot_key) DO UPDATE
           SET run_id = EXCLUDED.run_id, updated_at = now()
         WHERE proactive_messages.status = 'planned'
           AND proactive_messages.updated_at < now() - make_interval(secs => $7)
         RETURNING id`,
        [
          candidate.userId,
          kind,
          slot.slotKey,
          slot.localDate,
          slot.timezone,
          runId ?? null,
          STALE_CLAIM_SECONDS,
        ],
      ),
    );
    return rows[0]?.id ?? null;
  }

  /** Записать решение, при котором сообщения не было. */
  private async record(
    kind: ProactiveKind,
    candidate: ProactiveCandidate,
    slot: { slotKey: string; localDate: string; timezone: string },
    status: "skipped",
    options: { reason?: string; runId?: string },
  ): Promise<void> {
    try {
      await this.db.withUserScope(
        { userId: candidate.userId, label: "proactive.record", inherit: true },
        async () => await this.db.query(
          `INSERT INTO proactive_messages
             (user_id, kind, slot_key, local_date, timezone, status, reason, run_id)
           VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)
           ON CONFLICT (user_id, kind, slot_key) DO NOTHING`,
          [
            candidate.userId,
            kind,
            slot.slotKey,
            slot.localDate,
            slot.timezone,
            status,
            options.reason ?? null,
            options.runId ?? null,
          ],
        ),
      );
    } catch (error) {
      this.logger.warn("Решение о молчании не записано", {
        kind,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }

  private async finish(
    id: string,
    status: "sent" | "skipped" | "failed",
    reason: string | null,
    outboxId: string | null,
  ): Promise<void> {
    await this.db.withSystemScope(
      "proactive.finish",
      async () => await this.db.query(
        `-- tenant: system — строка адресуется своим первичным ключом,
         -- владелец назначен при занятии слота и не меняется
         UPDATE proactive_messages
            SET status = $2, reason = $3, outbox_id = $4
          WHERE id = $1`,
        [id, status, reason, outboxId],
      ),
      { crossUser: true },
    );
  }

  /**
   * Суточный эпизод.
   *
   * Утро и вечер одного дня — одна строка; ссылка на предыдущий день
   * позволяет вечеру говорить об утреннем намерении, а следующему утру —
   * об итоге вечера (требование 6 шага 8). Связь именно ссылкой:
   * пересказ прошлого дня разошёлся бы с самим прошлым днём.
   */
  private async ensureEpisode(
    candidate: ProactiveCandidate,
    localDate: string,
    timezone: string,
  ): Promise<EpisodeLink> {
    return await this.db.withUserScope(
      { userId: candidate.userId, label: "proactive.episode", inherit: true },
      async () => {
        const previous = await this.db.query<{
          id: string;
          local_date: string;
          evening_outcome_ref: string | null;
        }>(
          `SELECT id, local_date::text AS local_date, evening_outcome_ref
             FROM checkin_episodes
            WHERE user_id = $1 AND local_date < $2::date
            ORDER BY local_date DESC
            LIMIT 1`,
          [candidate.userId, localDate],
        );
        const previousRow = previous.rows[0];
        const { rows } = await this.db.query<{
          id: string;
          morning_intent_ref: string | null;
          evening_outcome_ref: string | null;
        }>(
          `INSERT INTO checkin_episodes (user_id, local_date, timezone, previous_id)
           VALUES ($1, $2::date, $3, $4)
           ON CONFLICT (user_id, local_date) DO UPDATE
             SET timezone = checkin_episodes.timezone
           RETURNING id, morning_intent_ref, evening_outcome_ref`,
          [candidate.userId, localDate, timezone, previousRow?.id ?? null],
        );
        const row = rows[0]!;
        return {
          episodeId: row.id,
          localDate,
          morningIntentRef: row.morning_intent_ref,
          eveningOutcomeRef: row.evening_outcome_ref,
          previousLocalDate: previousRow?.local_date ?? null,
          previousEveningOutcomeRef: previousRow?.evening_outcome_ref ?? null,
        };
      },
    );
  }

  private async linkEpisode(
    kind: ProactiveKind,
    userId: number,
    episode: EpisodeLink,
    messageId: string,
  ): Promise<void> {
    const column = kind === "checkin_morning" ? "morning_message_id" : "evening_message_id";
    await this.db.withUserScope(
      { userId, label: "proactive.episode.link", inherit: true },
      async () => await this.db.query(
        `UPDATE checkin_episodes
            SET ${column} = $3
          WHERE id = $1 AND user_id = $2`,
        [episode.episodeId, userId, messageId],
      ),
    );
    await this.db.withSystemScope(
      "proactive.episode.attach",
      async () => await this.db.query(
        `-- tenant: system — строка адресуется своим первичным ключом,
         -- владелец назначен при занятии слота
         UPDATE proactive_messages SET episode_id = $2 WHERE id = $1`,
        [messageId, episode.episodeId],
      ),
      { crossUser: true },
    );
  }
}
