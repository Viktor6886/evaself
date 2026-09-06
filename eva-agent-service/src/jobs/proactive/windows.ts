/**
 * Окна, в которые человек разрешил Еве писать первой.
 *
 * Человек называет промежуток — «с одиннадцати до двенадцати», — а
 * минуту внутри него выбирает планировщик. Смысл случайности не в
 * разнообразии: сообщение, приходящее ровно в 11:00 каждый день, читается
 * как будильник, кем бы оно ни было подписано.
 *
 * Случайность обязана быть выбрана ОДИН раз и пережить перезапуск.
 * Бросок на каждом заходе диспетчера означал бы, что минута всё время
 * впереди (и сообщение не придёт никогда) либо всё время позади (и оно
 * придёт на каждом заходе). Поэтому выбранная минута — это строка
 * `proactive_messages` со статусом `scheduled`, а уникальный слот делает
 * повторный бросок невозможным: второй `INSERT` в те же сутки того же
 * окна не проходит.
 *
 * Местное время считается luxon и зоной IANA, как и в `policy.ts`:
 * в ночь перехода на летнее время «одиннадцать утра», вычисленное
 * арифметикой над UTC, промахивается ровно в тот день, когда человек
 * особенно замечает время.
 */

import { DateTime } from "luxon";

import type { Database } from "../../db.js";
import type { Logger } from "../../logger.js";
import { initiativeSlotKey, zone } from "./policy.js";

/** Окно человека. Границы — минуты от местной полуночи. */
export interface ProactiveWindow {
  id: string;
  userId: number;
  startMinute: number;
  endMinute: number;
  /** Дни недели по ISO: 1 — понедельник, 7 — воскресенье. */
  weekdays: number[];
  timezone: string;
}

/** Минута выбрана: когда писать и до какого момента это ещё уместно. */
export interface WindowOccurrence {
  localDate: string;
  slotKey: string;
  scheduledFor: Date;
  validUntil: Date;
}

/**
 * Сколько окон человек может завести.
 *
 * Потолок не про базу: каждое окно — это ход агента, и десяток окон в
 * сутки превращает companion в рассылку. Ограничение стоит и в
 * публичном API, и здесь — выборка не должна зависеть от того, что
 * кто-то обошёл проверку API.
 */
export const MAX_WINDOWS_PER_USER = 6;

/** Минимальная ширина окна. Совпадает с `proactive_windows_width_check`. */
export const MIN_WINDOW_MINUTES = 15;

/**
 * Минута внутри окна для конкретных местных суток.
 *
 * `null` означает, что в этот день недели окно не работает.
 *
 * Правый край исключается: окно 11:00–12:00 даёт минуты с 11:00 по
 * 11:59, а не 12:00. Иначе два соседних окна («до двенадцати» и «с
 * двенадцати») делили бы одну минуту.
 */
export function windowOccurrence(
  window: Pick<ProactiveWindow, "id" | "startMinute" | "endMinute" | "weekdays">,
  localDate: string,
  timezone: string,
  random: () => number = Math.random,
): WindowOccurrence | null {
  const tz = zone(timezone);
  const day = DateTime.fromISO(localDate, { zone: tz }).startOf("day");
  if (!day.isValid) return null;
  if (!window.weekdays.includes(day.weekday)) return null;

  const width = window.endMinute - window.startMinute;
  if (width <= 0) return null;
  // `Math.min` страхует от `random()`, вернувшего единицу: спецификация
  // её исключает, но подменённый в тесте генератор — нет, а минута,
  // равная концу окна, ушла бы за его границу.
  const offset = Math.min(width - 1, Math.floor(random() * width));

  // Через `plus`, а не через `set({ hour, minute })`: в день перехода на
  // летнее время местного времени 02:30 не существует вовсе, и `set`
  // отдал бы невалидную дату. Прибавление к началу суток даёт ближайшее
  // существующее мгновение — сообщение сдвигается на час, а не пропадает.
  const scheduledFor = day.plus({ minutes: window.startMinute + offset });
  const validUntil = day.plus({ minutes: window.endMinute });
  return {
    localDate,
    slotKey: initiativeSlotKey(localDate, window.id),
    scheduledFor: scheduledFor.toJSDate(),
    validUntil: validUntil.toJSDate(),
  };
}

interface WindowRow {
  id: string;
  user_id: string;
  start_minute: number;
  end_minute: number;
  weekdays: number[] | null;
  timezone: string;
  local_date: string;
}

/**
 * Планировщик окон: выбирает минуты на сегодня и записывает их.
 *
 * Ничего не отправляет и ни одного хода агента не делает — бросок
 * стоит одного `INSERT`. Отправкой занимается диспетчер, когда минута
 * наступит.
 */
export class ProactiveWindowPlanner {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Разложить сегодняшние окна по минутам.
   *
   * Возвращает число записанных строк. Уже разложенные окна выборкой не
   * забираются, поэтому обычный заход не делает ничего и стоит одного
   * индексного запроса.
   */
  async plan(limit = 200): Promise<number> {
    const rows = await this.due(limit);
    let planned = 0;
    for (const row of rows) {
      const occurrence = windowOccurrence(
        {
          id: row.id,
          startMinute: row.start_minute,
          endMinute: row.end_minute,
          weekdays: row.weekdays ?? [],
        },
        row.local_date,
        row.timezone,
        this.random,
      );
      // Сегодня окно не работает — этот день недели человек не выбирал.
      if (!occurrence) continue;
      if (await this.record(Number(row.user_id), row.id, row.timezone, occurrence)) {
        planned += 1;
      }
    }
    if (planned > 0) this.logger.info("Окна инициативы разложены по минутам", { planned });
    return planned;
  }

  /**
   * Окна, для которых на сегодня минута ещё не выбрана.
   *
   * Местная дата считается в SQL зоной пользователя: вычитывать всех
   * людей ради вопроса «какое у него сегодня число» дороже, чем
   * ответить на него в базе.
   *
   * Согласие проверяется здесь же: выключенная инициатива не должна
   * оставлять после себя запланированных строк, которые диспетчер потом
   * будет отменять по одной.
   */
  private async due(limit: number): Promise<WindowRow[]> {
    const { rows } = await this.db.withSystemScope(
      "proactive.windows.due",
      async () => await this.db.query<WindowRow>(
        `-- tenant: system — планировщик раскладывает окна всех пользователей,
         -- сообщение готовится уже в области владельца
         SELECT w.id, w.user_id, w.start_minute, w.end_minute, w.weekdays,
                COALESCE(u.timezone, 'UTC') AS timezone,
                to_char(
                  (now() AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date, 'YYYY-MM-DD'
                ) AS local_date
           FROM proactive_windows w
           JOIN users u ON u.id = w.user_id
           JOIN agent_links a
             ON a.user_id = u.id AND a.kind = 'eva' AND a.status = 'active'
           LEFT JOIN user_preferences p ON p.user_id = u.id
          WHERE w.enabled
            AND u.state = 'active'
            AND NOT u.is_blocked
            AND a.conversation_id IS NOT NULL
            AND COALESCE(p.heartbeat_enabled, true)
            AND NOT EXISTS (
              SELECT 1 FROM proactive_messages m
               WHERE m.user_id = w.user_id
                 AND m.kind = 'initiative'
                 AND m.slot_key = to_char(
                       (now() AT TIME ZONE COALESCE(u.timezone, 'UTC'))::date, 'YYYY-MM-DD'
                     ) || ':initiative:' || w.id::text
            )
          ORDER BY w.user_id, w.start_minute
          LIMIT $1`,
        [limit],
      ),
      { crossUser: true },
    );
    return rows;
  }

  /**
   * Записать выбранную минуту.
   *
   * `ON CONFLICT DO NOTHING` — не перестраховка: между выборкой и
   * записью успевает пройти вторая реплика, и без него она перекатила бы
   * минуту уже разложенного окна.
   */
  private async record(
    userId: number,
    windowId: string,
    timezone: string,
    occurrence: WindowOccurrence,
  ): Promise<boolean> {
    const { rowCount } = await this.db.withUserScope(
      { userId, label: "proactive.windows.plan", inherit: true },
      async () => await this.db.query(
        `INSERT INTO proactive_messages
           (user_id, kind, slot_key, local_date, timezone, status,
            scheduled_for, valid_until, window_id)
         VALUES ($1, 'initiative', $2, $3::date, $4, 'scheduled', $5, $6, $7)
         ON CONFLICT (user_id, kind, slot_key) DO NOTHING`,
        [
          userId,
          occurrence.slotKey,
          occurrence.localDate,
          timezone,
          occurrence.scheduledFor.toISOString(),
          occurrence.validUntil.toISOString(),
          windowId,
        ],
      ),
    );
    return (rowCount ?? 0) > 0;
  }
}
