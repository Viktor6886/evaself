/**
 * Подписки: чтение, ручное назначение, смена тарифа, продление, отмена и
 * снятие ручного решения.
 *
 * Главное различие, ради которого этот сервис существует: **платёж и
 * право доступа — разные сущности** (инвариант 27). Строка, созданная
 * подтверждением оплаты, и строка, назначенная администратором, живут в одной
 * таблице `subscriptions`, но означают разное, и путать их нельзя:
 *
 *   `source = 'payment'` — за неё заплатили. Административная правка её
 *     не трогает вовсе: снять оплаченный доступ «по ошибке» нельзя, а
 *     ручное решение поверх него — отдельная строка;
 *   `source = 'manual'`  — решение администратора. Его видно, его можно
 *     снять, и после снятия человек возвращается к тому, за что заплатил;
 *   `source = 'promo'`   — выдано кодом (регистрация, акция);
 *   `source = 'trial'`   — пробный период.
 *
 * Схема разрешает ровно одну действующую подписку на человека
 * (`subscriptions_active_uidx` по статусам `trialing`/`active`/`past_due`),
 * поэтому ручное назначение не «добавляет вторую», а становится
 * действующим решением, а прежняя строка уходит в историю со статусом
 * `expired` или `canceled` — с сохранением её `source` и срока. Снятие
 * ручного решения восстанавливает последнюю строку оплаты, если её период
 * ещё не истёк.
 *
 * Telegram Stars создаёт платёжную строку через общий сервис выдачи доступа.
 * Колонка `source` имеет значение по умолчанию `payment`, поэтому источник
 * оплаты остаётся отделён от административного решения.
 *
 * Всё изменяющее пишется дважды: в доменную историю
 * `subscription_admin_events` (что именно решили о доступе) и в общий
 * `audit_log` через маршрут (кто, когда и с каким исходом вызвал).
 */

import type pg from "pg";

import { adminBadRequest, adminNotFound } from "./errors.js";

export type SubscriptionSource = "payment" | "manual" | "promo" | "trial";

export interface SubscriptionActor {
  id: string | null;
  username: string;
}

export interface SubscriptionRow {
  id: number;
  plan: string;
  status: string;
  source: SubscriptionSource;
  provider: string | null;
  started_at: string;
  current_period_start: string;
  current_period_end: string | null;
  canceled_at: string | null;
  actor_name: string | null;
  note: string | null;
}

/** Статусы, которые схема считает действующей подпиской. */
const LIVE_STATUSES = ["trialing", "active", "past_due"];

const PLAN_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_PERIOD_DAYS = 3650;

function planOf(value: unknown): string {
  const plan = String(value ?? "").trim().toLowerCase();
  if (!PLAN_RE.test(plan)) {
    throw adminBadRequest("Тариф — строчные латинские буквы, цифры, дефис и подчёркивание");
  }
  return plan;
}

function userIdOf(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw adminBadRequest("Некорректный user_id");
  return parsed;
}

function reasonOf(value: unknown): string {
  const reason = String(value ?? "").trim();
  // Причина теряется первой, а спрашивают о ней всегда — через полгода
  // «кто и зачем выдал этому человеку год доступа» разбирается только по
  // ней.
  if (!reason) throw adminBadRequest("Нужна причина изменения");
  return reason.slice(0, 500);
}

/**
 * Срок окончания периода.
 *
 * Два взаимоисключающих способа: явная дата или число дней от текущего
 * конца периода. `null` означает бессрочный доступ — это законное ручное
 * решение («пока не отменю»), а не пропущенное поле, поэтому оно
 * запрашивается отдельным флагом, а не отсутствием даты.
 */
function periodEndOf(input: Record<string, unknown>, base: Date | null): Date | null {
  if (input.no_expiry === true) return null;
  if (typeof input.period_end === "string" && input.period_end.trim()) {
    const parsed = new Date(input.period_end);
    if (Number.isNaN(parsed.getTime())) throw adminBadRequest("period_end — дата в формате ISO");
    if (parsed.getTime() <= Date.now()) throw adminBadRequest("period_end уже в прошлом");
    return parsed;
  }
  if (input.days !== undefined) {
    const days = Number.parseInt(String(input.days), 10);
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_PERIOD_DAYS) {
      throw adminBadRequest(`days — целое число от 1 до ${MAX_PERIOD_DAYS}`);
    }
    const from = base && base.getTime() > Date.now() ? base : new Date();
    return new Date(from.getTime() + days * 86_400_000);
  }
  throw adminBadRequest("Нужен period_end, days или no_expiry");
}

export class SubscriptionAdminService {
  constructor(private readonly pool: pg.Pool) {}

  /** Доступ человека: действующая подписка, история и ручные решения. */
  async forUser(rawUserId: unknown): Promise<Record<string, unknown>> {
    const userId = userIdOf(rawUserId);
    const [user, current, history, events, payments] = await Promise.all([
      this.pool.query<{ id: string; telegram_id: string; is_blocked: boolean; state: string }>(
        `-- tenant: system — карточка подписки в админке; доступ под ролью и записью аудита
         SELECT id, telegram_id, is_blocked, state FROM v_user_overview WHERE id = $1`,
        [userId],
      ),
      this.currentOf(userId),
      this.pool.query<SubscriptionRow>(
        `-- tenant: system — история подписок в админке; доступ под ролью и записью аудита
         SELECT id, plan, status, source, provider, started_at, current_period_start,
                current_period_end, canceled_at, actor_name, note
           FROM subscriptions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [userId],
      ),
      this.pool.query(
        `-- tenant: system — журнал ручных решений по доступу; доступ под ролью и записью аудита
         SELECT id, action, plan, status, period_end, actor_name, reason, created_at
           FROM subscription_admin_events
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [userId],
      ),
      this.pool.query(
        `-- tenant: system — оплаты в карточке подписки; доступ под ролью и записью аудита
         SELECT id, provider, amount_minor, currency, status, description, paid_at
           FROM payments
          WHERE user_id = $1
          ORDER BY COALESCE(paid_at, created_at) DESC
          LIMIT 20`,
        [userId],
      ),
    ]);
    if (!user.rows[0]) throw adminNotFound("Пользователь не найден");

    return {
      user: user.rows[0],
      current,
      access: this.access(user.rows[0], current),
      history: history.rows,
      events: events.rows,
      payments: payments.rows,
    };
  }

  /** Свод по установке: сколько кого и на чём. Нужен разделу «Подписки». */
  async summary(): Promise<Record<string, unknown>> {
    const [byPlan, expiring] = await Promise.all([
      this.pool.query(
        `-- tenant: system — свод по подпискам установки; доступ под ролью и записью аудита
         SELECT plan, source, status, count(*)::bigint AS total
           FROM subscriptions
          WHERE status = ANY($1::text[])
          GROUP BY plan, source, status
          ORDER BY plan, source`,
        [LIVE_STATUSES],
      ),
      this.pool.query(
        `-- tenant: system — подписки, истекающие в ближайшие две недели; доступ под ролью и записью аудита
         SELECT s.user_id, u.telegram_id, u.username, s.plan, s.source,
                s.status, s.current_period_end
           FROM subscriptions s
           JOIN users u ON u.id = s.user_id
          WHERE s.status = ANY($1::text[])
            AND s.current_period_end IS NOT NULL
            AND s.current_period_end <= now() + interval '14 days'
          ORDER BY s.current_period_end
          LIMIT 50`,
        [LIVE_STATUSES],
      ),
    ]);
    return { by_plan: byPlan.rows, expiring: expiring.rows };
  }

  /**
   * Назначить ручную подписку.
   *
   * Прежняя действующая строка помечается `expired` — она остаётся в
   * истории со своим `source` и сроком, поэтому снятие ручного решения
   * позже может её восстановить.
   */
  async assign(
    rawUserId: unknown,
    input: Record<string, unknown>,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    const userId = userIdOf(rawUserId);
    const plan = planOf(input.plan);
    const reason = reasonOf(input.reason);
    const current = await this.currentOf(userId);
    const periodEnd = periodEndOf(
      input,
      current?.current_period_end ? new Date(current.current_period_end) : null,
    );

    const row = await this.replaceCurrent(userId, {
      plan,
      periodEnd,
      actor,
      note: reason,
      keepPeriodStart: false,
    });
    await this.record(userId, row, "assign", actor, reason);
    return { subscription: row };
  }

  /** Сменить тариф действующей подписки, сохранив срок. */
  async changePlan(
    rawUserId: unknown,
    input: Record<string, unknown>,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    const userId = userIdOf(rawUserId);
    const plan = planOf(input.plan);
    const reason = reasonOf(input.reason);
    const current = await this.requireCurrent(userId);
    const row = await this.replaceCurrent(userId, {
      plan,
      periodEnd: current.current_period_end ? new Date(current.current_period_end) : null,
      actor,
      note: reason,
      keepPeriodStart: true,
      periodStart: new Date(current.current_period_start),
    });
    await this.record(userId, row, "change_plan", actor, reason);
    return { subscription: row };
  }

  /**
   * Продлить действующую подписку.
   *
   * Продление считается от текущего конца периода, а не от «сейчас»:
   * иначе продление за неделю до конца отбирало бы у человека эту неделю.
   * Тариф и происхождение сохраняются — продлённая оплата остаётся
   * оплатой, но получает отметку о том, кто её продлил.
   */
  async extend(
    rawUserId: unknown,
    input: Record<string, unknown>,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    const userId = userIdOf(rawUserId);
    const reason = reasonOf(input.reason);
    const current = await this.requireCurrent(userId);
    // Продление бессрочной подписки числом дней её бы ограничило: срока
    // не было, а после «продлить на 30 дней» он появился бы. Это ровно
    // обратное тому, что оператор нажимал. Явная дата остаётся
    // разрешённой — это осознанная смена срока, а не продление.
    if (current.current_period_end === null && input.days !== undefined) {
      throw adminBadRequest(
        "Подписка бессрочная: продление числом дней задало бы ей срок. "
          + "Укажите дату окончания, если срок нужен.",
      );
    }
    const periodEnd = periodEndOf(
      input,
      current.current_period_end ? new Date(current.current_period_end) : null,
    );
    const { rows } = await this.pool.query<SubscriptionRow>(
      `-- tenant: system — административное продление подписки; область объявлена маршрутом и записана в аудит
       UPDATE subscriptions
          SET current_period_end = $2,
              status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END,
              actor_id = $3::uuid,
              actor_name = $4,
              note = $5,
              updated_at = now()
        WHERE id = $1
        RETURNING id, plan, status, source, provider, started_at, current_period_start,
                  current_period_end, canceled_at, actor_name, note`,
      [current.id, periodEnd, actor.id, actor.username, reason],
    );
    const row = rows[0]!;
    await this.record(userId, row, "extend", actor, reason);
    return { subscription: row };
  }

  /**
   * Отменить действующую подписку.
   *
   * Отмена, а не удаление: строка остаётся со статусом `canceled` и
   * временем отмены. Человек теряет доступ, а история — нет.
   */
  async cancel(
    rawUserId: unknown,
    input: Record<string, unknown>,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    const userId = userIdOf(rawUserId);
    const reason = reasonOf(input.reason);
    const current = await this.requireCurrent(userId);
    const { rows } = await this.pool.query<SubscriptionRow>(
      `-- tenant: system — административная отмена подписки; область объявлена маршрутом и записана в аудит
       UPDATE subscriptions
          SET status = 'canceled',
              canceled_at = now(),
              actor_id = $2::uuid,
              actor_name = $3,
              note = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING id, plan, status, source, provider, started_at, current_period_start,
                  current_period_end, canceled_at, actor_name, note`,
      [current.id, actor.id, actor.username, reason],
    );
    const row = rows[0]!;
    await this.record(userId, row, "cancel", actor, reason);
    return { subscription: row };
  }

  /**
   * Снять ручное решение и вернуться к оплаченному доступу.
   *
   * Именно это отличает ручное назначение от отмены: администратор
   * снимает **своё** решение, а не отбирает у человека то, за что тот
   * заплатил. Если действующая подписка не ручная, снимать нечего —
   * маршрут отвечает отказом, а не молча отменяет оплату.
   */
  async clearManual(
    rawUserId: unknown,
    input: Record<string, unknown>,
    actor: SubscriptionActor,
  ): Promise<Record<string, unknown>> {
    const userId = userIdOf(rawUserId);
    const reason = reasonOf(input.reason);
    const current = await this.requireCurrent(userId);
    if (current.source !== "manual") {
      throw adminBadRequest(
        `Действующая подписка не ручная (${current.source}): снимать нечего. `
          + "Отобрать оплаченный доступ можно только отменой, и это другое действие.",
      );
    }

    const restored = await this.pool.query<SubscriptionRow>(
      `-- tenant: system — восстановление оплаченного доступа после снятия ручного решения; область объявлена маршрутом и записана в аудит
       SELECT id, plan, status, source, provider, started_at, current_period_start,
              current_period_end, canceled_at, actor_name, note
         FROM subscriptions
        WHERE user_id = $1
          AND source = 'payment'
          AND (current_period_end IS NULL OR current_period_end > now())
          AND id <> $2
        ORDER BY current_period_end DESC NULLS FIRST, created_at DESC
        LIMIT 1`,
      [userId, current.id],
    );

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `-- tenant: system — снятие ручного решения; область объявлена маршрутом и записана в аудит
         UPDATE subscriptions
            SET status = 'expired', actor_id = $2::uuid, actor_name = $3, note = $4, updated_at = now()
          WHERE id = $1`,
        [current.id, actor.id, actor.username, reason],
      );
      if (restored.rows[0]) {
        await client.query(
          `-- tenant: system — возврат оплаченной подписки в действующие; область объявлена маршрутом и записана в аудит
           UPDATE subscriptions SET status = 'active', updated_at = now() WHERE id = $1`,
          [restored.rows[0].id],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    const next = await this.currentOf(userId);
    await this.record(userId, next ?? current, "clear_manual", actor, reason);
    return { subscription: next, restored_payment: Boolean(restored.rows[0]) };
  }

  // -------------------------------------------------------------------

  private async currentOf(userId: number): Promise<SubscriptionRow | null> {
    const { rows } = await this.pool.query<SubscriptionRow>(
      `-- tenant: system — действующая подписка в админке; доступ под ролью и записью аудита
       SELECT id, plan, status, source, provider, started_at, current_period_start,
              current_period_end, canceled_at, actor_name, note
         FROM subscriptions
        WHERE user_id = $1 AND status = ANY($2::text[])
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, LIVE_STATUSES],
    );
    return rows[0] ?? null;
  }

  private async requireCurrent(userId: number): Promise<SubscriptionRow> {
    const current = await this.currentOf(userId);
    if (!current) throw adminNotFound("У пользователя нет действующей подписки");
    return current;
  }

  /**
   * Сделать новую строку действующей.
   *
   * Единственная транзакция, в которой уникальный индекс «одна
   * действующая подписка на человека» не может быть нарушен: прежняя
   * помечается истёкшей и новая вставляется одним заходом.
   */
  private async replaceCurrent(
    userId: number,
    input: {
      plan: string;
      periodEnd: Date | null;
      actor: SubscriptionActor;
      note: string;
      keepPeriodStart: boolean;
      periodStart?: Date;
    },
  ): Promise<SubscriptionRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `-- tenant: system — прежняя подписка уходит в историю перед ручным назначением; область объявлена маршрутом и записана в аудит
         UPDATE subscriptions SET status = 'expired', updated_at = now()
          WHERE user_id = $1 AND status = ANY($2::text[])`,
        [userId, LIVE_STATUSES],
      );
      const { rows } = await client.query<SubscriptionRow>(
        `-- tenant: system — ручное назначение подписки администратором; область объявлена маршрутом и записана в аудит
         INSERT INTO subscriptions
           (user_id, plan, status, source, provider, started_at,
            current_period_start, current_period_end, actor_id, actor_name, note)
         VALUES ($1, $2, 'active', 'manual', NULL, now(),
                 COALESCE($3::timestamptz, now()), $4, $5::uuid, $6, $7)
         RETURNING id, plan, status, source, provider, started_at, current_period_start,
                   current_period_end, canceled_at, actor_name, note`,
        [
          userId,
          input.plan,
          input.keepPeriodStart ? input.periodStart ?? null : null,
          input.periodEnd,
          input.actor.id,
          input.actor.username,
          input.note,
        ],
      );
      await client.query("COMMIT");
      return rows[0]!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async record(
    userId: number,
    row: SubscriptionRow | null,
    action: "assign" | "change_plan" | "extend" | "cancel" | "clear_manual",
    actor: SubscriptionActor,
    reason: string,
  ): Promise<void> {
    await this.pool.query(
      `-- tenant: system — доменная история решений по доступу; область объявлена маршрутом и записана в аудит
       INSERT INTO subscription_admin_events
         (user_id, subscription_id, action, plan, status, period_end,
          actor_id, actor_name, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8, $9)`,
      [
        userId,
        row?.id ?? null,
        action,
        row?.plan ?? null,
        row?.status ?? null,
        row?.current_period_end ?? null,
        actor.id,
        actor.username,
        reason,
      ],
    );
  }

  /**
   * Действующее право доступа по инварианту 27.
   *
   * Порядок фиксирован и считается здесь, а не в интерфейсе: панель
   * показывает то, что решил сервер, иначе два места считали бы доступ
   * по-разному.
   */
  private access(
    user: { is_blocked: boolean; state: string },
    current: SubscriptionRow | null,
  ): { level: string; reason: string; source: SubscriptionSource | null } {
    if (user.is_blocked) {
      return { level: "blocked", reason: "Пользователь заблокирован", source: null };
    }
    if (user.state === "paused") {
      return { level: "suspended", reason: "Ручная приостановка", source: null };
    }
    if (!current) {
      return { level: "free", reason: "Действующей подписки нет: бесплатная квота", source: null };
    }
    const expired = current.current_period_end !== null
      && new Date(current.current_period_end).getTime() <= Date.now();
    if (expired) {
      return {
        level: "free",
        reason: "Срок подписки истёк: бесплатная квота",
        source: current.source,
      };
    }
    const level = {
      manual: "manual_override",
      payment: "paid",
      promo: "promo",
      trial: "trial",
    }[current.source] ?? "paid";
    return {
      level,
      reason: {
        manual_override: "Действует ручное решение администратора",
        paid: "Оплаченная подписка",
        promo: "Промо-подписка",
        trial: "Пробный период",
      }[level] ?? "Оплаченная подписка",
      source: current.source,
    };
  }
}
