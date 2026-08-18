import type { Database } from "../db.js";
import {
  LanguageResolver,
  type SupportedLanguage,
} from "../i18n/language-resolver.js";
import { shouldSuppressProfileQuestion } from "../profile/profile-completeness.js";
import {
  humanizeInterval,
  localDateWithWeekday,
  localNow,
} from "../time/local-date-time.js";
import { appendRoutingMarker, type RoutingMarkerClaims } from "../router/routing-marker.js";
import {
  batchSummary,
  timelineLines,
  type MessageBatchTiming,
} from "../turns/message-timeline.js";
import { TaskEventService } from "../tasks/task-event-service.js";

export interface RuntimeContext {
  userId: number;
  telegramId: number;
  agentId: string;
  conversationId: string;
  purpose: string;
  localTime: string;
  /** Локальная дата словами вместе с днём недели. */
  localDate: string;
  /**
   * То же мгновение в UTC.
   *
   * Местное время без UTC неоднозначно ровно там, где ошибка заметнее
   * всего: в час перевода стрелок одна и та же настенная отметка
   * встречается дважды, а «через сколько» и «какой это был день»
   * считаются уже по мгновению, а не по циферблату.
   */
  utcTime: string;
  /** День недели, месяц и год отдельными полями: их называют вслух. */
  weekday: string;
  month: string;
  year: number;
  /**
   * Сколько прошло с предыдущего сообщения человека. `null` — предыдущего
   * сообщения нет: разговор начинается.
   */
  sincePreviousMessage: string | null;
  timezone: string;
  city: string | null;
  countryCode: string | null;
  responseLanguage: SupportedLanguage;
  responseMode: "text" | "voice" | "both";
  useEmoji: boolean;
  communicationStyle: string | null;
  profileHint: string | null;
  activeGoal: string | null;
  nextResult: string | null;
  nextStep: string | null;
  llmQualityMode?: "economy" | "auto" | "quality";
  taskActivity?: string[];
  /** Ближайшие напоминания: когда сработают и через сколько. */
  upcomingReminders?: string[];
  /** Окно быстрых сообщений: сколько их и за какое время. `null` — одно. */
  messageBatch?: string | null;
  /** По строке на сообщение окна: порядок, время и промежуток. */
  messageTimeline?: string[];
  metrics?: {
    runtimeContextMs: number;
    profileCheckMs: number;
    cacheHit: boolean;
  };
}

export type MessageSource = "text" | "voice" | "image" | "document" | "unsupported";

interface RuntimeContextRow {
  user_id: string;
  telegram_id: string;
  language_code: string | null;
  language_mode: "auto" | "fixed";
  preferred_language: string | null;
  last_message_language: string | null;
  timezone: string;
  city: string | null;
  country_code: string | null;
  agent_id: string;
  conversation_id: string;
  purpose: string;
  response_mode: "text" | "voice" | "both";
  use_emoji: boolean;
  communication_style: string | null;
  profile_field_key: string | null;
  profile_title: string | null;
  profile_prompt_hint: string | null;
  profile_status: string | null;
  active_goal_title: string | null;
  next_result_title: string | null;
  next_action: string | null;
  llm_quality_mode: "economy" | "auto" | "quality";
}

/**
 * Потолок служебного блока хода.
 *
 * В блоке остаются только факты этого хода, и типичный размер — около
 * 450 знаков. Потолок нужен не для экономии, а как сигнал: ход, который
 * к нему подошёл, почти наверняка тащит в контекст то, чему место в
 * персоне или навыке. Прежние шесть тысяч знаков такой сигнал не давали
 * вовсе — под ними умещался целый свод правил.
 */
export const RUNTIME_CONTEXT_CEILING = 2_000;

/**
 * Размеры последних собранных блоков.
 *
 * Хранится не текст, а длина: по ней видно, растёт ли служебный блок,
 * и не видно, о чём был разговор. Кольцо на пятьсот значений — это
 * несколько часов обычной нагрузки и несколько килобайт памяти.
 */
const SIZE_WINDOW = 500;
const sizes: number[] = [];
let nearCeilingTotal = 0;

export function recordRuntimeContextSize(
  characters: number,
  ceiling = RUNTIME_CONTEXT_CEILING,
): void {
  sizes.push(characters);
  if (sizes.length > SIZE_WINDOW) sizes.shift();
  // «Подошёл к потолку» — девять десятых от него: к моменту, когда блок
  // упрётся, разбираться будет уже поздно.
  if (characters >= ceiling * 0.9) nearCeilingTotal += 1;
}

export interface RuntimeContextSizeStats {
  samples: number;
  p50: number;
  p95: number;
  max: number;
  nearCeilingTotal: number;
  ceiling: number;
}

export function runtimeContextSizeStats(): RuntimeContextSizeStats {
  if (sizes.length === 0) {
    return { samples: 0, p50: 0, p95: 0, max: 0, nearCeilingTotal, ceiling: RUNTIME_CONTEXT_CEILING };
  }
  const sorted = [...sizes].sort((left, right) => left - right);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * (sorted.length - 1) + 0.5))] ?? 0;
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1] ?? 0,
    nearCeilingTotal,
    ceiling: RUNTIME_CONTEXT_CEILING,
  };
}

export class RuntimeContextBuilder {
  private readonly languageResolver: LanguageResolver;
  private readonly taskEvents: TaskEventService;
  private readonly cache = new Map<string, { expiresAt: number; row: RuntimeContextRow }>();

  constructor(
    private readonly db: Database,
    private readonly options: {
      defaultTimezone: string;
      cacheTtlMs?: number;
      maxContextCharacters?: number;
      profileCompletionEnabled?: boolean;
      vectorGoalsEnabled?: boolean;
      now?: () => Date;
      routingMarkerSecret?: string;
    },
  ) {
    this.languageResolver = new LanguageResolver(db);
    this.taskEvents = new TaskEventService(db);
  }

  async build(input: {
    userId: number;
    conversationId: string;
    userMessage: string;
    languageMessage?: string;
    detectLanguage?: boolean;
    /** Canonical TurnLifecycle run_id; never synthesize one in context code. */
    turnId?: string;
    modelPolicy?: "economy" | "auto" | "quality";
    /**
     * Когда человек писал в прошлый раз. Значение приходит снаружи и не
     * кэшируется вместе со строкой контекста: промежуток меняется каждым
     * сообщением, а строка живёт до конца TTL.
     */
    previousUserMessageAt?: Date | null;
    /**
     * Когда отправлено первое сообщение этого хода. Промежуток считается
     * от него, а не от момента обработки: между отправкой и ходом стоит
     * durable inbox, и очередь добавляет к промежутку своё время.
     */
    currentMessageAt?: Date | null;
    /**
     * Окно быстрых сообщений. Строки собираются здесь, а не у
     * вызывающего: часовой пояс человека известен только после выборки.
     */
    messageBatch?: MessageBatchTiming;
  }): Promise<RuntimeContext> {
    const started = performance.now();
    const loaded = await this.load(input.userId, input.conversationId);
    const row = loaded.row;
    const language = await this.languageResolver.resolve(
      input.userId,
      {
        languageMode: row.language_mode,
        preferredLanguage: row.preferred_language,
        lastMessageLanguage: row.last_message_language,
        telegramLanguageCode: row.language_code,
      },
      input.detectLanguage === false
        ? ""
        : (input.languageMessage ?? input.userMessage),
    );
    if (language.detected) row.last_message_language = language.detected;
    if (language.fixed && row.language_mode !== "fixed") {
      row.language_mode = "fixed";
      row.preferred_language = language.language;
    }
    const timezone = validTimezoneOr(row.timezone, this.options.defaultTimezone);
    const local = localNow(timezone, this.options.now?.() ?? new Date());
    const profileStarted = performance.now();
    const profileHint = this.options.profileCompletionEnabled === false ||
      shouldSuppressProfileQuestion(input.languageMessage ?? input.userMessage)
      ? null
      : profileHintFrom(row);
    const profileCheckMs = elapsed(profileStarted);
    // Оба запроса задач независимы, поэтому идут одним заходом: путь
    // ответа человеку не должен ждать два round-trip подряд.
    // Момент напоминания и остаток до него считает серверный код: модель
    // берёт такой остаток из головы и ошибается на часы.
    const [taskActivity, upcomingReminders] = await Promise.all([
      this.taskEvents.contextLines(input.userId, timezone).catch(() => []),
      this.taskEvents.upcomingLines(input.userId, timezone, local.toJSDate()).catch(() => []),
    ]);
    return {
      userId: Number(row.user_id),
      telegramId: Number(row.telegram_id),
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      purpose: row.purpose,
      localTime: local.toISO({ suppressMilliseconds: true }) ?? local.toUTC().toISO()!,
      localDate: localDateWithWeekday(local),
      utcTime: local.toUTC().toISO({ suppressMilliseconds: true })!,
      weekday: local.setLocale("ru").toFormat("cccc"),
      month: local.setLocale("ru").toFormat("LLLL"),
      year: local.year,
      sincePreviousMessage: sincePrevious(
        input.currentMessageAt ?? local.toJSDate(),
        input.previousUserMessageAt ?? null,
      ),
      timezone,
      city: row.city,
      countryCode: row.country_code,
      responseLanguage: language.language,
      responseMode: row.response_mode,
      useEmoji: row.use_emoji,
      communicationStyle: row.communication_style,
      profileHint,
      activeGoal: this.options.vectorGoalsEnabled === false ? null : row.active_goal_title ?? null,
      nextResult: this.options.vectorGoalsEnabled === false ? null : row.next_result_title ?? null,
      nextStep: this.options.vectorGoalsEnabled === false ? null : row.next_action ?? null,
      llmQualityMode: input.modelPolicy ?? row.llm_quality_mode,
      taskActivity,
      upcomingReminders,
      messageBatch: input.messageBatch ? batchSummary(input.messageBatch) : null,
      messageTimeline: input.messageBatch ? timelineLines(input.messageBatch, timezone) : [],
      metrics: {
        runtimeContextMs: elapsed(started),
        profileCheckMs,
        cacheHit: loaded.cacheHit,
      },
    };
  }

  wrapUserMessage(
    context: RuntimeContext,
    userMessage: string,
    options: {
      messageSource?: MessageSource;
      internalOperationType?: string;
      correlationId?: string;
      /** Куда сложить измеренный размер собранного контекста. */
      measure?: (characters: number) => void;
    } = {},
  ): string {
    const fields: Array<[string, string | null]> = [
      ["local_time", context.localTime],
      ["local_date", context.localDate],
      ["weekday", context.weekday],
      ["month", context.month],
      ["year", String(context.year)],
      ["utc_time", context.utcTime],
      // Промежуток между сообщениями — факт хода. Что с ним делать,
      // Ева знает из персоны: правило постоянное, и платить за него в
      // каждом сообщении незачем.
      ["since_previous_user_message", context.sincePreviousMessage],
      ["timezone", context.timezone],
      ["city", context.city],
      ["response_language", context.responseLanguage],
      ["response_mode", context.responseMode],
      ["communication_style", context.communicationStyle],
      ["message_source", options.messageSource ?? null],
      [
        "message_source_note",
        options.messageSource === "voice"
          ? "USER_MESSAGE is the speech-to-text transcript of a voice message sent by the user"
          : null,
      ],
      [
        "profile_hint",
        this.options.profileCompletionEnabled === false ? null : context.profileHint,
      ],
      ["active_goal", context.activeGoal],
      ["next_result", context.nextResult],
      ["next_step", context.nextStep],
    ];
    const lines = fields
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => `${key}: ${escapeContextValue(value)}`);
    // Окно быстрых сообщений стоит рядом с промежутком: без него «пошли
    // кушать» и «покушали» через секунду читаются как рассказ о
    // состоявшемся обеде, а не как две реплики одной мысли.
    const timeline = (context.messageTimeline ?? []).slice(0, 5);
    if (context.messageBatch) lines.push(`message_batch: ${escapeContextValue(context.messageBatch)}`);
    if (timeline.length > 0) {
      lines.push("message_times:", ...timeline.map((item) => `  - ${escapeContextValue(item)}`));
    }
    const events = (context.taskActivity ?? []).slice(0, 5)
      .map((item) => `  - ${escapeContextValue(item)}`);
    if (events.length > 0) lines.push("recent_task_events:", ...events);

    // Ближайшие напоминания стоят рядом с местным временем и приходят с
    // уже посчитанным остатком: «через сколько» — это арифметика, а её
    // модель делает неверно и уверенно.
    const upcoming = (context.upcomingReminders ?? []).slice(0, 3);
    if (upcoming.length > 0) {
      lines.push(
        "upcoming_reminders:",
        ...upcoming.map((item) => `  - ${escapeContextValue(item)}`),
      );
    }
    const limit = Math.max(1_000, this.options.maxContextCharacters ?? RUNTIME_CONTEXT_CEILING);
    const characters = lines.join("\n").length;
    options.measure?.(characters);
    recordRuntimeContextSize(characters, limit);
    // В блоке остаются только факты этого хода. Кто такая Ева, как она
    // пишет в Telegram, что делает с промежутком времени и как ведёт
    // цели — постоянные правила: они живут в персоне и в навыках, то
    // есть попадают в контекст один раз, а не с каждым сообщением.
    const contextBlock = lines.join("\n").slice(0, limit);
    const wrapped = [
      "<EVA_RUNTIME_CONTEXT>",
      contextBlock,
      "</EVA_RUNTIME_CONTEXT>",
      "",
      "<USER_MESSAGE>",
      escapeUserMessage(userMessage),
      "</USER_MESSAGE>",
    ].join("\n");
    return appendRoutingMarker(wrapped, {
      purpose: context.purpose as RoutingMarkerClaims["purpose"],
      message_source: options.messageSource,
      user_mode: context.llmQualityMode ?? "auto",
      internal_operation_type: options.internalOperationType,
      correlation_id: options.correlationId,
    }, this.options.routingMarkerSecret ?? "");
  }

  invalidate(userId: number): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}:`)) this.cache.delete(key);
    }
  }

  private async load(
    userId: number,
    conversationId: string,
  ): Promise<{ row: RuntimeContextRow; cacheHit: boolean }> {
    const key = `${userId}:${conversationId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { row: cached.row, cacheHit: true };
    }
    const { rows } = await this.db.query<RuntimeContextRow>(
      `SELECT
          u.id AS user_id,
          u.telegram_id,
          u.language_code,
          u.language_mode,
          u.preferred_language,
          u.last_message_language,
          COALESCE(NULLIF(u.timezone, ''), $3) AS timezone,
          u.city,
          u.country_code,
          a.agent_id,
          c.conversation_id,
          c.purpose,
          COALESCE(p.response_mode, 'text') AS response_mode,
          COALESCE(p.use_emoji, true) AS use_emoji,
          p.character AS communication_style,
          COALESCE(p.llm_quality_mode, 'auto') AS llm_quality_mode,
          profile_hint.field_key AS profile_field_key,
          profile_hint.title AS profile_title,
          profile_hint.prompt_hint AS profile_prompt_hint,
          profile_hint.status AS profile_status,
          goal_context.active_goal_title,
          goal_context.next_result_title,
          goal_context.next_action
        FROM users u
        JOIN agent_conversations c
          ON c.user_id = u.id
         AND c.conversation_id = $2
         AND c.status = 'active'
        JOIN agent_links a
          ON a.user_id = u.id
         AND a.agent_id = c.agent_id
         AND a.kind = 'eva'
         AND a.status = 'active'
        LEFT JOIN user_preferences p ON p.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT
            d.field_key,
            d.title,
            d.prompt_hint,
            f.status
          FROM profile_field_definitions d
          LEFT JOIN onboarding_fields f
            ON f.user_id = u.id AND f.field_key = d.field_key
          WHERE d.enabled
            AND $4::boolean
            AND COALESCE(f.status, 'missing') NOT IN
                ('confirmed', 'declined', 'not_applicable', 'superseded')
            AND COALESCE(f.ask_count, 0) < d.max_ask_count
            AND (
              f.last_asked_at IS NULL
              OR f.last_asked_at <= now() - make_interval(days => d.cooldown_days)
            )
            AND d.sensitivity = 'normal'
          ORDER BY
            CASE WHEN f.status = 'candidate' THEN 0 ELSE 1 END,
            d.priority,
            d.sort_order
          LIMIT 1
        ) profile_hint ON true
        LEFT JOIN LATERAL (
          SELECT
            g.title AS active_goal_title,
            next_result.title AS next_result_title,
            COALESCE(
              next_block.first_physical_step,
              next_block.intention,
              next_result.first_action
            ) AS next_action
          FROM goals g
          LEFT JOIN LATERAL (
            SELECT r.title, r.first_action
              FROM goal_results r
             WHERE r.user_id = u.id
               AND r.goal_id = g.id
               AND r.status NOT IN ('completed', 'skipped')
             ORDER BY
               CASE r.status
                 WHEN 'in_progress' THEN 0
                 WHEN 'ready' THEN 1
                 WHEN 'draft' THEN 2
                 WHEN 'blocked' THEN 3
                 ELSE 4
               END,
               r.is_critical_path DESC,
               r.sort_order,
               r.id
             LIMIT 1
          ) next_result ON true
          LEFT JOIN LATERAL (
            SELECT b.first_physical_step, b.intention
              FROM work_blocks b
             WHERE b.user_id = u.id
               AND b.goal_id = g.id
               AND b.status IN ('active', 'planned')
             ORDER BY
               CASE b.status WHEN 'active' THEN 0 ELSE 1 END,
               b.planned_start_at NULLS LAST,
               b.id
             LIMIT 1
          ) next_block ON true
          WHERE g.user_id = u.id
            AND $5::boolean
            AND g.status = 'active'
            AND g.user_confirmed
          ORDER BY g.priority, g.updated_at DESC
          LIMIT 1
        ) goal_context ON true
       WHERE u.id = $1
       LIMIT 1`,
      [
        userId,
        conversationId,
        this.options.defaultTimezone,
        this.options.profileCompletionEnabled !== false,
        this.options.vectorGoalsEnabled !== false,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Не найден runtime-контекст пользователя и conversation");
    this.cache.set(key, {
      expiresAt: Date.now() + Math.max(1_000, this.options.cacheTtlMs ?? 45_000),
      row,
    });
    return { row, cacheHit: false };
  }
}

function profileHintFrom(row: RuntimeContextRow): string | null {
  if (!row.profile_field_key || !row.profile_title) return null;
  if (row.profile_status === "candidate") {
    return [
      `Есть неподтверждённое сведение «${row.profile_title}».`,
      "Если это естественно связано с текущей темой, попроси подтвердить или отклонить его.",
      "Не задавай больше одного дополнительного вопроса.",
    ].join(" ");
  }
  return [
    `Не заполнено поле «${row.profile_title}».`,
    row.profile_prompt_hint ?? "",
    "Если пользователь явно назовёт ответ, сохрани его инструментом профиля.",
    "Не превращай разговор в анкету.",
  ].filter(Boolean).join(" ");
}

function validTimezoneOr(value: string, fallback: string): string {
  for (const candidate of [value, fallback, "UTC"]) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: candidate }).format();
      return candidate;
    } catch {
      // Try the next trusted fallback.
    }
  }
  return "UTC";
}

function escapeContextValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000);
}

function escapeUserMessage(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}

/**
 * Сколько прошло с предыдущего сообщения человека.
 *
 * Без этой строки модель видит только текущее время и достраивает
 * промежуток из смысла слов: человек написал «пошёл делать» и через
 * секунду «сделал» — и она спрашивает, как всё прошло, будто прошёл
 * вечер. Часы идут вперёд не всегда монотонно (перевод времени, правка
 * системных часов), поэтому отрицательный промежуток — это «только что»,
 * а не отрицательное число в контексте.
 */
function sincePrevious(now: Date, previous: Date | null): string | null {
  if (!previous || Number.isNaN(previous.getTime())) return null;
  return humanizeInterval(Math.max(0, now.getTime() - previous.getTime()));
}
