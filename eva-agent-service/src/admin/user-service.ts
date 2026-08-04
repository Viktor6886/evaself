import type pg from "pg";

import { adminBadRequest, adminNotFound } from "./errors.js";
import type { InternalAgentClient } from "./provider-service.js";

/**
 * Раздел «Пользователи» — люди, которые общаются с Евой в Telegram.
 *
 * Список и карточка собираются существующими представлениями
 * v_user_overview и v_quota_status: они написаны ровно под этот экран и
 * переписывать их незачем.
 *
 * Про блокировку. Диалог останавливается при is_blocked ИЛИ
 * state='blocked' (eva-workflow), а фоновые рассылки требуют
 * state='active' И NOT is_blocked (background). Два поля означают четыре
 * сочетания, из которых два противоречивы, поэтому наружу выставлена не
 * пара флагов, а одно действие: заблокировать / разблокировать. Оба поля
 * пишутся одним UPDATE, разойтись им негде.
 */

/** Состояния, которые оператор может выставить руками. */
const ASSIGNABLE_STATES = new Set(["active", "paused"]);

/** Сколько сообщений отдаём за один запрос переписки. */
const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 200;

export interface UserListFilter {
  query?: string;
  state?: string;
  plan?: string;
  blocked?: boolean;
  limit?: number;
  offset?: number;
}

export interface UserActor {
  id: string | null;
  username: string;
}

interface AgentMessage {
  [key: string]: unknown;
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function userId(raw: unknown): number {
  // Строго одни цифры, а не Number.parseInt: тот берёт ведущее число и
  // молча превращает «1; DROP TABLE users» в единицу. Инъекции здесь не
  // будет — значение уходит параметром, — но оператор по битой ссылке
  // подействовал бы не на того пользователя.
  const text = String(raw ?? "");
  if (!/^\d+$/.test(text)) {
    throw adminBadRequest("Некорректный идентификатор пользователя");
  }
  const parsed = Number(text);
  // bigserial, но за пределами Number.MAX_SAFE_INTEGER точность теряется,
  // а такого количества пользователей в установке не будет.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw adminBadRequest("Некорректный идентификатор пользователя");
  }
  return parsed;
}

export class UserService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly agent: InternalAgentClient,
  ) {}

  // -------------------------------------------------------------------
  // список
  // -------------------------------------------------------------------
  async list(filter: UserListFilter) {
    const limit = boundedLimit(filter.limit, 50, 200);
    const offset = Math.max(0, Number.parseInt(String(filter.offset ?? 0), 10) || 0);

    const where: string[] = [];
    const params: unknown[] = [];

    const query = (filter.query ?? "").trim();
    if (query) {
      // Поиск по username, имени и telegram_id одним полем ввода: оператор
      // обычно знает что-то одно и не должен выбирать, что именно.
      params.push(`%${query}%`);
      const like = `$${params.length}`;
      const digits = /^\d+$/.test(query);
      if (digits) {
        params.push(query);
        where.push(
          `(username ILIKE ${like} OR first_name ILIKE ${like}` +
          ` OR telegram_id::text = $${params.length})`,
        );
      } else {
        where.push(`(username ILIKE ${like} OR first_name ILIKE ${like})`);
      }
    }
    if (filter.state) {
      params.push(filter.state);
      where.push(`state = $${params.length}`);
    }
    if (filter.plan) {
      params.push(filter.plan);
      where.push(`plan = $${params.length}`);
    }
    if (filter.blocked !== undefined) {
      params.push(filter.blocked);
      where.push(`is_blocked = $${params.length}`);
    }

    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows: totalRows } = await this.pool.query(
      `
        -- tenant: system — раздел «Пользователи» админки: список идёт по всем, доступ под ролью и записью аудита
        SELECT count(*)::bigint AS total FROM v_user_overview ${clause}`,
      params,
    );

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `
        -- tenant: system — раздел «Пользователи» админки: список идёт по всем, доступ под ролью и записью аудита
        SELECT id, telegram_id, username, first_name, state, is_blocked,
              language_code, timezone, plan, subscription_status,
              current_period_end, message_count, last_message_at,
              created_at, last_seen_at
         FROM v_user_overview
         ${clause}
        ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      users: rows,
      total: Number(totalRows[0]?.total ?? 0),
      limit,
      offset,
    };
  }

  // -------------------------------------------------------------------
  // карточка
  // -------------------------------------------------------------------
  async get(rawId: unknown) {
    const id = userId(rawId);

    const { rows } = await this.pool.query(
      `SELECT o.*, u.city, u.country_code, u.language_mode, u.preferred_language,
              u.timezone_source, u.consent_at, u.notes
         FROM v_user_overview o
         JOIN users u ON u.id = o.id
        WHERE o.id = $1`,
      [id],
    );
    const user = rows[0];
    if (!user) throw adminNotFound("Пользователь не найден");

    const [quotas, preferences, notes, activity, crisis] = await Promise.all([
      this.pool.query(
        `SELECT metric, period, limit_value, used, remaining
           FROM v_quota_status WHERE user_id = $1 ORDER BY metric, period`,
        [id],
      ),
      this.pool.query(
        `SELECT response_mode, voice, character, agent_mode, use_emoji,
                heartbeat_enabled, heartbeat_min_silence, heartbeat_min_interval
           FROM user_preferences WHERE user_id = $1`,
        [id],
      ),
      this.pool.query(
        `SELECT id, actor_name, note, created_at
           FROM admin_user_notes WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [id],
      ),
      this.pool.query(
        `SELECT count(*)::bigint AS updates_total,
                count(*) FILTER (WHERE status = 'failed')::bigint AS updates_failed,
                max(received_at) AS last_update_at
           FROM telegram_updates WHERE user_id = $1`,
        [id],
      ),
      // Только метаданные: тексты trigger_text/response_text — это прямая
      // речь человека в кризисе, и в карточке им не место.
      this.pool.query(
        `SELECT id, severity, handled, handled_at, created_at
           FROM crisis_events WHERE user_id = $1
          ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
    ]);

    return {
      user,
      quotas: quotas.rows,
      preferences: preferences.rows[0] ?? null,
      notes: notes.rows,
      activity: activity.rows[0] ?? null,
      crisis_events: crisis.rows,
    };
  }

  // -------------------------------------------------------------------
  // переписка
  // -------------------------------------------------------------------
  /**
   * Переписка пользователя: сообщения из Letta и выдержки из PostgreSQL.
   *
   * Сообщения admin-api берёт не из Letta напрямую: единственный
   * компонент, которому разрешено говорить с App Server, — это
   * eva-agent-service (зафиксировано в compose.yaml). Поэтому запрос идёт
   * по внутренней сети в его же маршрут, который умеет это делать.
   *
   * Если Letta недоступна, выдержки всё равно возвращаются: они лежат в
   * PostgreSQL и не зависят от App Server. Поэтому ошибка сообщений —
   * поле в ответе, а не исключение на весь запрос.
   */
  async conversation(rawId: unknown, rawLimit: unknown) {
    const id = userId(rawId);
    const limit = boundedLimit(rawLimit, MESSAGES_DEFAULT, MESSAGES_MAX);

    const { rows } = await this.pool.query(
      `SELECT telegram_id, username, first_name FROM users WHERE id = $1`,
      [id],
    );
    const user = rows[0];
    if (!user) throw adminNotFound("Пользователь не найден");

    const [messages, highlights, conversations] = await Promise.all([
      this.fetchMessages(String(user.telegram_id), limit),
      this.pool.query(
        `SELECT id, highlight_type, title, content, source_quote,
                importance, occurred_at, created_at
           FROM conversation_highlights
          WHERE user_id = $1 AND status = 'active'
          ORDER BY COALESCE(occurred_at, created_at) DESC
          LIMIT 50`,
        [id],
      ),
      this.pool.query(
        `SELECT conversation_id, title, status, message_count,
                started_at, last_message_at
           FROM agent_conversations WHERE user_id = $1
          ORDER BY COALESCE(last_message_at, started_at) DESC
          LIMIT 20`,
        [id],
      ),
    ]);

    return {
      user: {
        id,
        telegram_id: user.telegram_id,
        username: user.username,
        first_name: user.first_name,
      },
      conversations: conversations.rows,
      highlights: highlights.rows,
      ...messages,
    };
  }

  private async fetchMessages(telegramId: string, limit: number) {
    try {
      const payload = await this.agent.request(
        `/v1/conversations/${encodeURIComponent(telegramId)}/messages?limit=${limit}`,
      );
      const raw = payload as { messages?: unknown } | null;
      const list = Array.isArray(raw?.messages)
        ? raw.messages
        : Array.isArray(payload) ? payload : [];
      return { messages: list as AgentMessage[], messages_error: null as string | null };
    } catch (error) {
      // Сообщение об ошибке — техническое (нет conversation, App Server
      // недоступен); текста переписки в нём нет.
      return {
        messages: [] as AgentMessage[],
        messages_error: error instanceof Error ? error.message : "Переписка недоступна",
      };
    }
  }

  // -------------------------------------------------------------------
  // изменения
  // -------------------------------------------------------------------
  /**
   * Блокировка пишет оба поля сразу. Разблокировка возвращает состояние
   * 'active', а не прежнее: прежнего никто не сохранял, а 'active' — это
   * то, чего оператор и добивается, снимая блокировку.
   */
  async setBlocked(rawId: unknown, blocked: boolean) {
    const id = userId(rawId);
    const { rows } = await this.pool.query(
      `UPDATE users
          SET is_blocked = $2,
              state = CASE WHEN $2 THEN 'blocked' ELSE 'active' END,
              updated_at = now()
        WHERE id = $1
        RETURNING id, telegram_id, username, state, is_blocked`,
      [id, blocked],
    );
    if (!rows[0]) throw adminNotFound("Пользователь не найден");
    return rows[0];
  }

  /**
   * Поля, которые оператор правит руками. Блокировка сюда не входит: у
   * неё отдельное действие, иначе снова появилось бы два способа
   * выставить одно и то же состояние.
   */
  async update(rawId: unknown, body: Record<string, unknown>) {
    const id = userId(rawId);
    const sets: string[] = [];
    const params: unknown[] = [id];

    if (body.state !== undefined) {
      const state = String(body.state);
      if (!ASSIGNABLE_STATES.has(state)) {
        throw adminBadRequest(
          "Из панели можно выставить только 'active' или 'paused'; " +
          "блокировка выполняется отдельным действием",
        );
      }
      params.push(state);
      sets.push(`state = $${params.length}`);
      // Состояние и флаг снова не должны разойтись.
      sets.push("is_blocked = false");
    }

    if (body.timezone !== undefined) {
      const timezone = String(body.timezone).trim();
      if (!timezone) throw adminBadRequest("Часовой пояс не может быть пустым");
      // Проверяем, что пояс существует: неизвестное значение сломает
      // расчёт локального времени в рантайме, а не здесь.
      try {
        new Intl.DateTimeFormat("ru-RU", { timeZone: timezone });
      } catch {
        throw adminBadRequest(`Неизвестный часовой пояс: ${timezone}`);
      }
      params.push(timezone);
      sets.push(`timezone = $${params.length}`);
      params.push("admin");
      sets.push(`timezone_source = $${params.length}`);
      sets.push("timezone_updated_at = now()");
    }

    if (body.language_mode !== undefined) {
      const mode = String(body.language_mode);
      if (mode !== "auto" && mode !== "fixed") {
        throw adminBadRequest("language_mode принимает только 'auto' или 'fixed'");
      }
      params.push(mode);
      sets.push(`language_mode = $${params.length}`);
      sets.push("language_updated_at = now()");
    }

    if (body.preferred_language !== undefined) {
      const language = String(body.preferred_language).trim();
      params.push(language || null);
      sets.push(`preferred_language = $${params.length}`);
    }

    if (!sets.length) throw adminBadRequest("Нечего изменять");

    const { rows } = await this.pool.query(
      `UPDATE users SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1
        RETURNING id, telegram_id, username, state, is_blocked,
                  timezone, language_mode, preferred_language`,
      params,
    );
    if (!rows[0]) throw adminNotFound("Пользователь не найден");
    return rows[0];
  }

  /**
   * Заметка — единственная мутация раздела, которая не идемпотентна сама
   * по себе: блокировка и правка полей выставляют состояние, а повторно
   * отправленная форма заметки добавила бы дубль. Поэтому у неё ключ
   * идемпотентности, и повтор возвращает уже созданную запись.
   */
  async addNote(
    rawId: unknown,
    actor: UserActor,
    rawNote: unknown,
    idempotencyKey?: string,
  ) {
    const id = userId(rawId);
    const note = String(rawNote ?? "").trim();
    if (!note) throw adminBadRequest("Заметка не может быть пустой");
    if (note.length > 4000) throw adminBadRequest("Заметка длиннее 4000 символов");
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw adminBadRequest("Некорректный Idempotency-Key");
    }

    const { rows } = await this.pool.query(
      `INSERT INTO admin_user_notes (user_id, actor_id, actor_name, note, idempotency_key)
       SELECT $1, $2, $3, $4, $5 FROM users WHERE id = $1
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, actor_name, note, created_at`,
      [id, actor.id, actor.username.slice(0, 200), note, idempotencyKey ?? null],
    );
    if (rows[0]) return rows[0];

    // Ничего не вернулось по одной из двух причин: повтор по ключу или
    // отсутствующий пользователь (INSERT ... SELECT не вставит строку и
    // не поднимет ошибку внешнего ключа). Различаем их явно.
    if (idempotencyKey) {
      const { rows: existing } = await this.pool.query(
        `-- tenant: system — повтор по ключу идемпотентности в административной
           -- операции; ключ выдаёт сам администратор, доступ ограничен RBAC
           SELECT id, actor_name, note, created_at
             FROM admin_user_notes WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      if (existing[0]) return existing[0];
    }
    throw adminNotFound("Пользователь не найден");
  }
}
