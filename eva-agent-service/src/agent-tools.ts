import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import { nextCronDate } from "./background.js";
import type { Config } from "./config.js";
import type { AgentRuntimeContext, Database } from "./db.js";
import type { Logger } from "./logger.js";
import { UserProfileService } from "./profile/profile-service.js";
import { ALLOWED_REACTIONS, type TelegramClient } from "./telegram.js";
import { localDateTimeToUtc } from "./time/local-date-time.js";

type JsonObject = Record<string, unknown>;

const objectSchema = (
  properties: Record<string, JsonObject>,
  required: string[] = [],
): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const text = (description: string): JsonObject => ({ type: "string", description });
const integer = (description: string): JsonObject => ({ type: "integer", description });
const boolean = (description: string): JsonObject => ({ type: "boolean", description });

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Аргументы инструмента должны быть JSON-объектом");
  }
  return value as JsonObject;
}

function requiredString(args: JsonObject, name: string, max = 20_000): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name}: требуется непустая строка`);
  }
  return value.trim().slice(0, max);
}

function optionalString(args: JsonObject, name: string, max = 20_000): string | null {
  const value = args[name];
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name}: ожидается строка`);
  return value.trim().slice(0, max);
}

function optionalInteger(args: JsonObject, name: string): number | null {
  const value = args[name];
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}: ожидается целое число`);
  return parsed;
}

function result(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: serialized }], details: value };
}

export class AgentToolFactory {
  private readonly profile: UserProfileService;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly telegram: TelegramClient,
    private readonly logger: Logger,
    profile?: UserProfileService,
  ) {
    this.profile = profile ?? new UserProfileService(db);
  }

  forConversation(conversationId: string): AnyAgentTool[] {
    const context = async (): Promise<AgentRuntimeContext> => {
      const found = await this.db.getAgentRuntimeContext(conversationId);
      if (!found) throw new Error("Conversation не связан с пользователем Evaself");
      return found;
    };

    const tool = (
      name: string,
      label: string,
      description: string,
      parameters: JsonObject,
      execute: (args: JsonObject, runtime: AgentRuntimeContext) => Promise<unknown>,
    ): AnyAgentTool => ({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, rawArgs) => {
        try {
          return result(await execute(asObject(rawArgs), await context()));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn("Инструмент Agent SDK завершился ошибкой", {
            tool: name,
            conversationId,
            message,
          });
          return result({ ok: false, error: message });
        }
      },
    });

    const tools: AnyAgentTool[] = [
      tool(
        "update_response_mode",
        "Режим ответа",
        "Меняет формат ответа пользователю: текст, голос или оба варианта.",
        objectSchema({
          mode: { type: "string", enum: ["text", "voice", "both"] },
        }, ["mode"]),
        async (args, runtime) => {
          const mode = requiredString(args, "mode");
          if (!["text", "voice", "both"].includes(mode)) throw new Error("Неизвестный режим");
          await this.db.query(
            `INSERT INTO user_preferences (user_id, response_mode)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET response_mode = EXCLUDED.response_mode`,
            [runtime.userId, mode],
          );
          return { ok: true, response_mode: mode };
        },
      ),
      tool(
        "save_note",
        "Сохранить заметку",
        "Сохраняет личную заметку пользователя в PostgreSQL.",
        objectSchema({
          title: text("Короткий заголовок"),
          content: text("Содержание заметки"),
          category: text("Необязательная категория"),
          tags: { type: "array", items: { type: "string" } },
          pinned: boolean("Закрепить заметку"),
        }, ["title", "content"]),
        async (args, runtime) => {
          const tags = Array.isArray(args.tags)
            ? args.tags.filter((item): item is string => typeof item === "string").slice(0, 30)
            : [];
          const { rows } = await this.db.query(
            `INSERT INTO eva_notes (user_id, title, content, category, tags, pinned)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, title, category, tags, pinned, created_at`,
            [
              runtime.userId,
              requiredString(args, "title", 300),
              requiredString(args, "content", 100_000),
              optionalString(args, "category", 200),
              tags,
              args.pinned === true,
            ],
          );
          return { ok: true, note: rows[0] };
        },
      ),
      tool(
        "get_notes",
        "Получить заметки",
        "Ищет заметки текущего пользователя по тексту или категории.",
        objectSchema({
          query: text("Текст для поиска"),
          category: text("Категория"),
          limit: integer("Количество, максимум 100"),
        }),
        async (args, runtime) => {
          const limit = Math.min(Math.max(optionalInteger(args, "limit") ?? 20, 1), 100);
          const query = optionalString(args, "query", 500);
          const category = optionalString(args, "category", 200);
          const { rows } = await this.db.query(
            `SELECT id, title, content, category, tags, pinned, created_at, updated_at
               FROM eva_notes
              WHERE user_id = $1
                AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR content ILIKE '%' || $2 || '%')
                AND ($3::text IS NULL OR category = $3)
              ORDER BY pinned DESC, updated_at DESC
              LIMIT $4`,
            [runtime.userId, query, category, limit],
          );
          return { ok: true, notes: rows };
        },
      ),
      tool(
        "update_note",
        "Изменить заметку",
        "Изменяет принадлежащую текущему пользователю заметку.",
        objectSchema({
          id: integer("ID заметки"),
          title: text("Новый заголовок"),
          content: text("Новое содержание"),
          category: text("Новая категория"),
          pinned: boolean("Закрепить"),
        }, ["id"]),
        async (args, runtime) => {
          const id = optionalInteger(args, "id");
          const { rows } = await this.db.query(
            `UPDATE eva_notes SET
               title = COALESCE($3, title),
               content = COALESCE($4, content),
               category = CASE WHEN $5::boolean THEN $6 ELSE category END,
               pinned = COALESCE($7, pinned)
             WHERE id = $1 AND user_id = $2
             RETURNING id, title, content, category, tags, pinned, updated_at`,
            [
              id,
              runtime.userId,
              optionalString(args, "title", 300),
              optionalString(args, "content", 100_000),
              Object.hasOwn(args, "category"),
              optionalString(args, "category", 200),
              typeof args.pinned === "boolean" ? args.pinned : null,
            ],
          );
          return rows[0] ? { ok: true, note: rows[0] } : { ok: false, error: "Заметка не найдена" };
        },
      ),
      tool(
        "delete_notes",
        "Удалить заметки",
        "Удаляет одну или несколько заметок текущего пользователя.",
        objectSchema({
          ids: { type: "array", items: { type: "integer" }, maxItems: 100 },
        }, ["ids"]),
        async (args, runtime) => {
          const ids = Array.isArray(args.ids)
            ? args.ids.map(Number).filter(Number.isSafeInteger).slice(0, 100)
            : [];
          if (ids.length === 0) throw new Error("ids не должен быть пустым");
          const deleted = await this.db.query(
            "DELETE FROM eva_notes WHERE user_id = $1 AND id = ANY($2::bigint[])",
            [runtime.userId, ids],
          );
          return { ok: true, deleted: deleted.rowCount ?? 0 };
        },
      ),
      tool(
        "save_budget_record",
        "Записать доход или расход",
        "Сохраняет финансовую запись пользователя. amount указывается в обычных денежных единицах.",
        objectSchema({
          type: { type: "string", enum: ["income", "expense"] },
          amount: { type: "number", minimum: 0 },
          currency: text("Код валюты, например RUB"),
          date: text("Дата YYYY-MM-DD"),
          category: text("Категория"),
          store: text("Магазин или источник"),
          description: text("Описание"),
          payment_method: text("Способ оплаты"),
          quantity: { type: "number" },
        }, ["type", "amount"]),
        async (args, runtime) => {
          const amount = Number(args.amount);
          if (!Number.isFinite(amount) || amount < 0) throw new Error("Некорректная сумма");
          const { rows } = await this.db.query(
            `INSERT INTO budget_entries
               (user_id, occurred_on, entry_type, amount_minor, currency, category,
                store, description, payment_method, quantity)
             VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING *`,
            [
              runtime.userId,
              optionalString(args, "date", 10),
              requiredString(args, "type", 20),
              Math.round(amount * 100),
              optionalString(args, "currency", 3)?.toUpperCase() ?? "RUB",
              optionalString(args, "category", 200),
              optionalString(args, "store", 300),
              optionalString(args, "description", 2000),
              optionalString(args, "payment_method", 100),
              typeof args.quantity === "number" ? args.quantity : null,
            ],
          );
          return { ok: true, record: rows[0] };
        },
      ),
      tool(
        "get_budget_records",
        "Получить бюджет",
        "Возвращает записи бюджета и итог за выбранный период.",
        objectSchema({
          date_from: text("Начальная дата YYYY-MM-DD"),
          date_to: text("Конечная дата YYYY-MM-DD"),
          type: { type: "string", enum: ["income", "expense"] },
          category: text("Категория"),
          limit: integer("Количество, максимум 200"),
        }),
        async (args, runtime) => {
          const { rows } = await this.db.query(
            `SELECT id, occurred_on, entry_type, amount_minor, currency, category,
                    store, description, payment_method, quantity, created_at
               FROM budget_entries
              WHERE user_id = $1
                AND ($2::date IS NULL OR occurred_on >= $2)
                AND ($3::date IS NULL OR occurred_on <= $3)
                AND ($4::text IS NULL OR entry_type = $4)
                AND ($5::text IS NULL OR category = $5)
              ORDER BY occurred_on DESC, id DESC
              LIMIT $6`,
            [
              runtime.userId,
              optionalString(args, "date_from", 10),
              optionalString(args, "date_to", 10),
              optionalString(args, "type", 20),
              optionalString(args, "category", 200),
              Math.min(Math.max(optionalInteger(args, "limit") ?? 50, 1), 200),
            ],
          );
          const totals = rows.reduce<Record<string, number>>((acc, row) => {
            const record = row as { entry_type: string; amount_minor: string };
            acc[record.entry_type] = (acc[record.entry_type] ?? 0) + Number(record.amount_minor);
            return acc;
          }, {});
          return { ok: true, records: rows, totals_minor: totals };
        },
      ),
      tool(
        "update_budget_record",
        "Изменить запись бюджета",
        "Изменяет сумму, описание или категорию финансовой записи.",
        objectSchema({
          id: integer("ID записи"),
          amount: { type: "number", minimum: 0 },
          category: text("Категория"),
          description: text("Описание"),
          date: text("Дата YYYY-MM-DD"),
        }, ["id"]),
        async (args, runtime) => {
          const amount = typeof args.amount === "number" ? Math.round(args.amount * 100) : null;
          const { rows } = await this.db.query(
            `UPDATE budget_entries SET
               amount_minor = COALESCE($3, amount_minor),
               category = CASE WHEN $4::boolean THEN $5 ELSE category END,
               description = CASE WHEN $6::boolean THEN $7 ELSE description END,
               occurred_on = COALESCE($8::date, occurred_on)
             WHERE id = $1 AND user_id = $2
             RETURNING *`,
            [
              optionalInteger(args, "id"),
              runtime.userId,
              amount,
              Object.hasOwn(args, "category"),
              optionalString(args, "category", 200),
              Object.hasOwn(args, "description"),
              optionalString(args, "description", 2000),
              optionalString(args, "date", 10),
            ],
          );
          return rows[0] ? { ok: true, record: rows[0] } : { ok: false, error: "Запись не найдена" };
        },
      ),
      tool(
        "delete_budget_records",
        "Удалить записи бюджета",
        "Удаляет выбранные финансовые записи текущего пользователя.",
        objectSchema({
          ids: { type: "array", items: { type: "integer" }, maxItems: 100 },
        }, ["ids"]),
        async (args, runtime) => {
          const ids = Array.isArray(args.ids)
            ? args.ids.map(Number).filter(Number.isSafeInteger).slice(0, 100)
            : [];
          const deleted = await this.db.query(
            "DELETE FROM budget_entries WHERE user_id = $1 AND id = ANY($2::bigint[])",
            [runtime.userId, ids],
          );
          return { ok: true, deleted: deleted.rowCount ?? 0 };
        },
      ),
      ...this.profileTools(tool),
      ...this.taskTools(tool),
      ...this.todoistTools(tool),
      tool(
        "set_reaction",
        "Реакция Telegram",
        "Ставит допустимую emoji-реакцию на последнее сообщение пользователя.",
        objectSchema({ emoji: text("Одна поддерживаемая Telegram emoji") }, ["emoji"]),
        async (args, runtime) => {
          const emoji = requiredString(args, "emoji", 16);
          if (!runtime.useEmoji) return { ok: false, skipped: "Пользователь отключил emoji" };
          if (!ALLOWED_REACTIONS.has(emoji)) throw new Error("Telegram не поддерживает эту реакцию");
          const { rows } = await this.db.query<{ message_id: string }>(
            `SELECT message_id FROM telegram_updates
              WHERE user_id = $1 AND message_id IS NOT NULL
              ORDER BY received_at DESC LIMIT 1`,
            [runtime.userId],
          );
          const messageId = Number(rows[0]?.message_id);
          if (!Number.isSafeInteger(messageId)) throw new Error("Нет сообщения для реакции");
          await this.telegram.setReaction(runtime.chatId, messageId, emoji);
          return { ok: true, emoji };
        },
      ),
      tool(
        "web_search",
        "Поиск в интернете",
        "Ищет актуальную информацию через локальный приватный SearXNG.",
        objectSchema({
          query: text("Поисковый запрос"),
          limit: integer("Количество результатов, максимум 10"),
        }, ["query"]),
        async (args, runtime) => await this.search(
          requiredString(args, "query", 1000),
          optionalInteger(args, "limit") ?? 5,
          runtime,
        ),
      ),
    ];

    // Compatibility aliases let an imported old Eva blueprint keep working
    // while its prompt is migrated to the provider-neutral tool name.
    tools.push(
      tool(
        "PERPLEXITY_SEARCH",
        "Поиск в интернете",
        "Совместимый псевдоним web_search; запрос выполняется через локальный SearXNG.",
        objectSchema({ query: text("Поисковый запрос") }, ["query"]),
        async (args, runtime) => await this.search(requiredString(args, "query", 1000), 5, runtime),
      ),
      tool(
        "brave_search",
        "Поиск в интернете",
        "Совместимый псевдоним web_search; запрос выполняется через локальный SearXNG.",
        objectSchema({ query: text("Поисковый запрос") }, ["query"]),
        async (args, runtime) => await this.search(requiredString(args, "query", 1000), 5, runtime),
      ),
      tool(
        "LIGHTRAG_INSERT",
        "Сохранить в архивную память",
        "Сохраняет материал в приватные заметки пользователя.",
        objectSchema({ text: text("Материал"), title: text("Заголовок") }, ["text"]),
        async (args, runtime) => {
          const { rows } = await this.db.query(
            `INSERT INTO eva_notes (user_id, title, content, category, tags)
             VALUES ($1, $2, $3, 'archive', ARRAY['memory'])
             RETURNING id, title`,
            [runtime.userId, optionalString(args, "title", 300) ?? "Архивная память", requiredString(args, "text", 100_000)],
          );
          return { ok: true, note: rows[0] };
        },
      ),
      tool(
        "LIGHTRAG_QUERY",
        "Поиск в архивной памяти",
        "Ищет по приватным заметкам и архивной памяти текущего пользователя.",
        objectSchema({ query: text("Что найти"), limit: integer("Количество") }, ["query"]),
        async (args, runtime) => {
          const query = requiredString(args, "query", 1000);
          const { rows } = await this.db.query(
            `SELECT id, title, content, category, updated_at
               FROM eva_notes
              WHERE user_id = $1
                AND (title ILIKE '%' || $2 || '%' OR content ILIKE '%' || $2 || '%')
              ORDER BY pinned DESC, updated_at DESC LIMIT $3`,
            [runtime.userId, query, Math.min(optionalInteger(args, "limit") ?? 10, 30)],
          );
          return { ok: true, results: rows };
        },
      ),
    );

    return tools;
  }

  private profileTools(
    tool: (
      name: string,
      label: string,
      description: string,
      parameters: JsonObject,
      execute: (args: JsonObject, runtime: AgentRuntimeContext) => Promise<unknown>,
    ) => AnyAgentTool,
  ): AnyAgentTool[] {
    return [
      tool(
        "upsert_user_profile_field",
        "Сохранить поле профиля",
        "Сохраняет только явно сообщённое или хорошо подтверждённое сведение текущего пользователя. Чувствительные сведения остаются кандидатами до подтверждения.",
        objectSchema({
          field_key: text("Разрешённый ключ поля профиля"),
          value: { description: "Строка, массив строк или JSON-объект согласно типу поля" },
          source_quote: text("Короткая точная цитата пользователя"),
          confidence: { type: "number", minimum: 0, maximum: 1 },
          explicitly_stated: boolean("Пользователь сообщил это прямо, без интерпретации"),
        }, ["field_key", "value", "explicitly_stated"]),
        async (args, runtime) => ({
          ok: true,
          field: await this.profile.upsert({
            userId: runtime.userId,
            fieldKey: requiredString(args, "field_key", 100),
            value: args.value,
            sourceQuote: optionalString(args, "source_quote", 2_000),
            confidence: typeof args.confidence === "number" ? args.confidence : undefined,
            explicitlyStated: args.explicitly_stated === true,
          }),
        }),
      ),
      tool(
        "confirm_user_profile_field",
        "Подтвердить поле профиля",
        "Подтверждает существующий кандидат только после явного согласия пользователя.",
        objectSchema({ field_key: text("Ключ поля профиля") }, ["field_key"]),
        async (args, runtime) => ({
          ok: true,
          field: await this.profile.confirm(
            runtime.userId,
            requiredString(args, "field_key", 100),
          ),
        }),
      ),
      tool(
        "decline_user_profile_field",
        "Отклонить поле профиля",
        "Помечает поле отклонённым только после явного отказа пользователя; Ева больше не спрашивает о нём автоматически.",
        objectSchema({ field_key: text("Ключ поля профиля") }, ["field_key"]),
        async (args, runtime) => ({
          ok: true,
          field: await this.profile.decline(
            runtime.userId,
            requiredString(args, "field_key", 100),
          ),
        }),
      ),
      tool(
        "mark_profile_field_asked",
        "Отметить вопрос профиля",
        "Вызывается только если Ева действительно задала дополнительный вопрос о поле; включает cooldown и защищает от повторной анкеты.",
        objectSchema({ field_key: text("Ключ заданного поля") }, ["field_key"]),
        async (args, runtime) => {
          const fieldKey = requiredString(args, "field_key", 100);
          await this.profile.markAsked(runtime.userId, fieldKey);
          return { ok: true, field_key: fieldKey };
        },
      ),
      tool(
        "get_user_profile",
        "Получить профиль",
        "Возвращает подтверждённые сведения и кандидаты текущего пользователя без данных других пользователей.",
        objectSchema({}),
        async (_args, runtime) => ({
          ok: true,
          ...(await this.profile.getProfile(runtime.userId)),
        }),
      ),
    ];
  }

  private taskTools(
    tool: (
      name: string,
      label: string,
      description: string,
      parameters: JsonObject,
      execute: (args: JsonObject, runtime: AgentRuntimeContext) => Promise<unknown>,
    ) => AnyAgentTool,
  ): AnyAgentTool[] {
    const taskSchema = objectSchema({
      title: text("Название задачи"),
      description: text("Описание"),
      due_at: text("Дата и время ISO 8601"),
      remind_at: text("Дата напоминания ISO 8601"),
      cron: text("Cron из пяти полей"),
      repeat: boolean("Повторять по cron"),
      priority: integer("Приоритет от 1 до 5"),
      timezone: text("Часовой пояс IANA"),
    }, ["title"]);
    const save = async (args: JsonObject, runtime: AgentRuntimeContext) => {
      const priority = Math.min(Math.max(optionalInteger(args, "priority") ?? 3, 1), 5);
      const dueAtInput = optionalString(args, "due_at", 100);
      const remindAtInput = optionalString(args, "remind_at", 100);
      const cron = optionalString(args, "cron", 100);
      const requestedTimezone = optionalString(args, "timezone", 100);
      if (requestedTimezone && requestedTimezone !== runtime.timezone) {
        throw new Error(
          "Часовой пояс задачи должен совпадать с подтверждённым часовым поясом пользователя",
        );
      }
      const timezone = runtime.timezone;
      const dueAt = dueAtInput ? localDateTimeToUtc(dueAtInput, timezone) : null;
      const remindAt = remindAtInput ? localDateTimeToUtc(remindAtInput, timezone) : null;
      const repeat = args.repeat === true;
      if (repeat && !cron) throw new Error("Для повторяющейся задачи требуется cron");
      const nextRunAt = remindAt ?? dueAt ??
        (repeat && cron ? nextCronDate(cron, timezone, new Date()).toISOString() : null);
      const { rows } = await this.db.query(
        `INSERT INTO tasks
           (user_id, title, description, priority, due_at, remind_at,
            cron_expression, repeat_enabled, timezone, next_run_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz,
                 $7, $8, $9, $10::timestamptz)
         RETURNING *`,
        [
          runtime.userId,
          requiredString(args, "title", 500),
          optionalString(args, "description", 5000),
          priority,
          dueAt,
          remindAt,
          cron,
          repeat,
          timezone,
          nextRunAt,
        ],
      );
      return { ok: true, task: rows[0] };
    };

    return [
      tool(
        "save_task",
        "Сохранить задачу",
        "Создаёт одноразовую или повторяющуюся задачу пользователя.",
        taskSchema,
        save,
      ),
      tool(
        "save_task_to_nocodb",
        "Сохранить задачу",
        "Совместимое имя старого инструмента; задача сохраняется напрямую в PostgreSQL.",
        taskSchema,
        save,
      ),
      tool(
        "save_tasks_bulk_to_nocodb",
        "Сохранить несколько задач",
        "Создаёт несколько задач в одной операции.",
        objectSchema({
          tasks: { type: "array", items: taskSchema, minItems: 1, maxItems: 50 },
        }, ["tasks"]),
        async (args, runtime) => {
          if (!Array.isArray(args.tasks)) throw new Error("tasks должен быть массивом");
          const saved = [];
          for (const item of args.tasks.slice(0, 50)) saved.push(await save(asObject(item), runtime));
          return { ok: true, tasks: saved };
        },
      ),
      tool(
        "get_tasks",
        "Получить задачи",
        "Возвращает задачи текущего пользователя.",
        objectSchema({
          status: { type: "string", enum: ["open", "in_progress", "done", "canceled"] },
          limit: integer("Количество, максимум 100"),
        }),
        async (args, runtime) => {
          const { rows } = await this.db.query(
            `SELECT * FROM tasks
              WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
              ORDER BY COALESCE(next_run_at, remind_at, due_at) NULLS LAST, created_at DESC
              LIMIT $3`,
            [
              runtime.userId,
              optionalString(args, "status", 30),
              Math.min(Math.max(optionalInteger(args, "limit") ?? 30, 1), 100),
            ],
          );
          return { ok: true, tasks: rows };
        },
      ),
      tool(
        "update_task",
        "Изменить задачу",
        "Меняет статус, текст или срок принадлежащей пользователю задачи.",
        objectSchema({
          id: integer("ID задачи"),
          title: text("Название"),
          description: text("Описание"),
          status: { type: "string", enum: ["open", "in_progress", "done", "canceled"] },
          due_at: text("Новый срок ISO 8601"),
        }, ["id"]),
        async (args, runtime) => {
          const { rows } = await this.db.query(
            `UPDATE tasks SET
               title = COALESCE($3, title),
               description = CASE WHEN $4::boolean THEN $5 ELSE description END,
               status = COALESCE($6, status),
               due_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE due_at END,
               completed_at = CASE WHEN $6 = 'done' THEN now()
                                   WHEN $6 IS NOT NULL THEN NULL ELSE completed_at END
             WHERE id = $1 AND user_id = $2
             RETURNING *`,
            [
              optionalInteger(args, "id"),
              runtime.userId,
              optionalString(args, "title", 500),
              Object.hasOwn(args, "description"),
              optionalString(args, "description", 5000),
              optionalString(args, "status", 30),
              Object.hasOwn(args, "due_at"),
              optionalString(args, "due_at", 100)
                ? localDateTimeToUtc(optionalString(args, "due_at", 100)!, runtime.timezone)
                : null,
            ],
          );
          return rows[0] ? { ok: true, task: rows[0] } : { ok: false, error: "Задача не найдена" };
        },
      ),
      tool(
        "delete_tasks",
        "Удалить задачи",
        "Удаляет выбранные задачи текущего пользователя.",
        objectSchema({ ids: { type: "array", items: { type: "integer" }, maxItems: 100 } }, ["ids"]),
        async (args, runtime) => {
          const ids = Array.isArray(args.ids)
            ? args.ids.map(Number).filter(Number.isSafeInteger).slice(0, 100)
            : [];
          const deleted = await this.db.query(
            "DELETE FROM tasks WHERE user_id = $1 AND id = ANY($2::bigint[])",
            [runtime.userId, ids],
          );
          return { ok: true, deleted: deleted.rowCount ?? 0 };
        },
      ),
      tool(
        "get_tasks_from_nocodb",
        "Получить задачи",
        "Совместимое имя старого инструмента; читает задачи напрямую из PostgreSQL.",
        objectSchema({
          status: { type: "string", enum: ["open", "in_progress", "done", "canceled"] },
          limit: integer("Количество"),
        }),
        async (args, runtime) => {
          const { rows } = await this.db.query(
            `SELECT * FROM tasks
              WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
              ORDER BY COALESCE(next_run_at, remind_at, due_at) NULLS LAST, created_at DESC
              LIMIT $3`,
            [
              runtime.userId,
              optionalString(args, "status", 30),
              Math.min(Math.max(optionalInteger(args, "limit") ?? 30, 1), 100),
            ],
          );
          return { ok: true, tasks: rows };
        },
      ),
      tool(
        "update_task_in_nocodb",
        "Изменить задачу",
        "Совместимое имя старого инструмента; изменяет задачу в PostgreSQL.",
        objectSchema({
          id: integer("ID задачи"),
          task: text("Новое название"),
          status: { type: "string", enum: ["open", "in_progress", "done", "canceled"] },
          due_date: text("Новый срок ISO 8601"),
        }, ["id"]),
        async (args, runtime) => {
          const { rows } = await this.db.query(
            `UPDATE tasks SET
               title = COALESCE($3, title),
               status = COALESCE($4, status),
               due_at = COALESCE($5::timestamptz, due_at),
               next_run_at = COALESCE($5::timestamptz, next_run_at),
               completed_at = CASE WHEN $4 = 'done' THEN now() ELSE completed_at END
             WHERE id = $1 AND user_id = $2
             RETURNING *`,
            [
              optionalInteger(args, "id"),
              runtime.userId,
              optionalString(args, "task", 500),
              optionalString(args, "status", 30),
              optionalString(args, "due_date", 100)
                ? localDateTimeToUtc(optionalString(args, "due_date", 100)!, runtime.timezone)
                : null,
            ],
          );
          return rows[0] ? { ok: true, task: rows[0] } : { ok: false, error: "Задача не найдена" };
        },
      ),
      tool(
        "delete_tasks_from_nocodb",
        "Удалить задачи",
        "Совместимое имя старого инструмента; удаляет только задачи текущего пользователя.",
        objectSchema({
          ids: { type: "array", items: { type: "integer" }, maxItems: 100 },
          id: integer("Один ID задачи"),
        }),
        async (args, runtime) => {
          const ids = Array.isArray(args.ids)
            ? args.ids.map(Number).filter(Number.isSafeInteger).slice(0, 100)
            : optionalInteger(args, "id") !== null
              ? [optionalInteger(args, "id")!]
              : [];
          const deleted = await this.db.query(
            "DELETE FROM tasks WHERE user_id = $1 AND id = ANY($2::bigint[])",
            [runtime.userId, ids],
          );
          return { ok: true, deleted: deleted.rowCount ?? 0 };
        },
      ),
    ];
  }

  private todoistTools(
    tool: (
      name: string,
      label: string,
      description: string,
      parameters: JsonObject,
      execute: (args: JsonObject, runtime: AgentRuntimeContext) => Promise<unknown>,
    ) => AnyAgentTool,
  ): AnyAgentTool[] {
    const userLabel = (runtime: AgentRuntimeContext) => `eva-${runtime.telegramId}`;
    const requireOwnedTask = async (taskId: string, runtime: AgentRuntimeContext) => {
      const task = await this.todoistRequest("GET", `/tasks/${encodeURIComponent(taskId)}`) as {
        id?: string;
        labels?: string[];
        [key: string]: unknown;
      };
      if (!task.labels?.includes(userLabel(runtime))) {
        throw new Error("Todoist task не принадлежит текущему пользователю");
      }
      return task;
    };
    const list = async (runtime: AgentRuntimeContext) => {
      const query = new URLSearchParams({ limit: "200" });
      if (this.config.todoistProjectId) query.set("project_id", this.config.todoistProjectId);
      const raw = await this.todoistRequest("GET", `/tasks?${query}`) as
        | unknown[]
        | { results?: unknown[] };
      const tasks = Array.isArray(raw) ? raw : raw.results ?? [];
      return tasks.filter((task) => {
        const labels = (task as { labels?: unknown }).labels;
        return Array.isArray(labels) && labels.includes(userLabel(runtime));
      });
    };

    return [
      tool(
        "TODOIST_CREATE_TASK",
        "Создать задачу Todoist",
        "Создаёт задачу в настроенном Todoist и изолирует её меткой пользователя.",
        objectSchema({
          content: text("Название задачи"),
          due_string: text("Срок естественным языком или датой"),
          priority: integer("Приоритет Todoist 1–4"),
          description: text("Описание"),
        }, ["content"]),
        async (args, runtime) => {
          const priority = Math.min(Math.max(optionalInteger(args, "priority") ?? 1, 1), 4);
          const payload: JsonObject = {
            content: requiredString(args, "content", 500),
            description: optionalString(args, "description", 5_000) ?? "",
            labels: [userLabel(runtime)],
            priority,
          };
          const due = optionalString(args, "due_string", 300);
          if (due) payload.due_string = due;
          if (this.config.todoistProjectId) payload.project_id = this.config.todoistProjectId;
          return {
            ok: true,
            task: await this.todoistRequest("POST", "/tasks", payload),
          };
        },
      ),
      tool(
        "TODOIST_GET_ALL_TASKS",
        "Все задачи Todoist",
        "Возвращает все доступные задачи Todoist текущего пользователя.",
        objectSchema({}),
        async (_args, runtime) => ({ ok: true, tasks: await list(runtime) }),
      ),
      tool(
        "TODOIST_GET_ACTIVE_TASK",
        "Активные задачи Todoist",
        "Возвращает активные задачи Todoist текущего пользователя.",
        objectSchema({}),
        async (_args, runtime) => ({ ok: true, tasks: await list(runtime) }),
      ),
      tool(
        "TODOIST_GET_TASK",
        "Получить задачу Todoist",
        "Возвращает одну задачу после проверки пользовательской метки.",
        objectSchema({ task_id: text("ID задачи Todoist") }, ["task_id"]),
        async (args, runtime) => ({
          ok: true,
          task: await requireOwnedTask(requiredString(args, "task_id", 200), runtime),
        }),
      ),
      tool(
        "TODOIST_UPDATE_TASK",
        "Изменить задачу Todoist",
        "Изменяет задачу Todoist текущего пользователя.",
        objectSchema({
          task_id: text("ID задачи"),
          content: text("Новое название"),
          description: text("Новое описание"),
          due_string: text("Новый срок"),
          priority: integer("Приоритет 1–4"),
        }, ["task_id"]),
        async (args, runtime) => {
          const id = requiredString(args, "task_id", 200);
          const existing = await requireOwnedTask(id, runtime);
          const payload: JsonObject = {
            labels: Array.from(new Set([
              ...((existing.labels as string[] | undefined) ?? []),
              userLabel(runtime),
            ])),
          };
          for (const field of ["content", "description", "due_string"]) {
            const value = optionalString(args, field, field === "description" ? 5_000 : 500);
            if (value !== null) payload[field] = value;
          }
          const priority = optionalInteger(args, "priority");
          if (priority !== null) payload.priority = Math.min(Math.max(priority, 1), 4);
          return {
            ok: true,
            task: await this.todoistRequest(
              "POST",
              `/tasks/${encodeURIComponent(id)}`,
              payload,
            ),
          };
        },
      ),
      tool(
        "TODOIST_CLOSE_TASK",
        "Завершить задачу Todoist",
        "Закрывает принадлежащую пользователю задачу Todoist.",
        objectSchema({ task_id: text("ID задачи") }, ["task_id"]),
        async (args, runtime) => {
          const id = requiredString(args, "task_id", 200);
          await requireOwnedTask(id, runtime);
          await this.todoistRequest("POST", `/tasks/${encodeURIComponent(id)}/close`);
          return { ok: true, task_id: id, closed: true };
        },
      ),
      tool(
        "TODOIST_DELETE_TASK",
        "Удалить задачу Todoist",
        "Удаляет принадлежащую пользователю задачу Todoist.",
        objectSchema({ task_id: text("ID задачи") }, ["task_id"]),
        async (args, runtime) => {
          const id = requiredString(args, "task_id", 200);
          await requireOwnedTask(id, runtime);
          await this.todoistRequest("DELETE", `/tasks/${encodeURIComponent(id)}`);
          return { ok: true, task_id: id, deleted: true };
        },
      ),
      tool(
        "TODOIST_DELETE_ALL_TASKS",
        "Удалить все задачи Todoist",
        "Массово удаляет только задачи с меткой текущего пользователя. Требует confirm=DELETE.",
        objectSchema({ confirm: text("Точное слово DELETE") }, ["confirm"]),
        async (args, runtime) => {
          if (requiredString(args, "confirm", 20) !== "DELETE") {
            throw new Error("Массовое удаление требует confirm=DELETE");
          }
          const tasks = await list(runtime) as Array<{ id?: string }>;
          let deleted = 0;
          for (const task of tasks) {
            if (!task.id) continue;
            await this.todoistRequest("DELETE", `/tasks/${encodeURIComponent(task.id)}`);
            deleted += 1;
          }
          return { ok: true, deleted };
        },
      ),
    ];
  }

  private async todoistRequest(
    method: string,
    path: string,
    body?: JsonObject,
  ): Promise<unknown> {
    if (!this.config.todoistApiToken) {
      throw new Error("TODOIST_API_TOKEN не настроен администратором");
    }
    const base = this.config.todoistApiUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.config.todoistApiToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Todoist вернул HTTP ${response.status}: ${raw.slice(0, 500)}`);
    }
    if (response.status === 204) return null;
    const raw = await response.text();
    return raw ? JSON.parse(raw) as unknown : null;
  }

  private async search(
    query: string,
    requestedLimit: number,
    runtime: AgentRuntimeContext,
  ): Promise<unknown> {
    const quotas = await this.db.getQuotaStatus(runtime.telegramId);
    const quota = quotas.find((item) => item.metric === "web_search") as
      | { remaining?: string | number | null }
      | undefined;
    if (quota?.remaining !== null && quota?.remaining !== undefined && Number(quota.remaining) <= 0) {
      throw new Error("Лимит интернет-поиска на текущий период закончился");
    }
    const limit = Math.min(Math.max(requestedLimit, 1), 10);
    const base = this.config.searxngUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`SearXNG вернул HTTP ${response.status}`);
    const body = await response.json() as {
      results?: Array<{ title?: string; url?: string; content?: string; engine?: string }>;
    };
    const results = (body.results ?? []).slice(0, limit).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content,
      source: item.engine,
    }));
    await this.db.incrementUsage(runtime.telegramId, "web_search");
    return { ok: true, query, results };
  }
}
