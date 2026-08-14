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
import { TaskEventService } from "../tasks/task-event-service.js";
import {
  fitLevel,
  LEVEL_BUDGETS,
  type LevelMeasurement,
} from "./context-levels.js";

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
  relevantMemory: string[];
  skillLines?: string[];
  llmQualityMode?: "economy" | "auto" | "quality";
  taskActivity?: string[];
  /** Ближайшие напоминания: когда сработают и через сколько. */
  upcomingReminders?: string[];
  metrics?: {
    runtimeContextMs: number;
    profileCheckMs: number;
    cacheHit: boolean;
  };
  /**
   * Фактический размер каждого уровня контекста. Заполняется при
   * сборке сообщения: до неё измерять нечего.
   */
  levels?: LevelMeasurement[];
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
      skillContext?: (input: { userId: number; conversationId: string; purpose: string; message: string; turnId?: string; scenarioComplete?: boolean }) => Promise<string[]>;
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
    relevantMemory?: string[];
    detectLanguage?: boolean;
    /** Canonical TurnLifecycle run_id; never synthesize one in context code. */
    turnId?: string;
    memoryScopes?: readonly string[];
    allowedSkills?: readonly string[];
    modelPolicy?: "economy" | "auto" | "quality";
    /**
     * Когда человек писал в прошлый раз. Значение приходит снаружи и не
     * кэшируется вместе со строкой контекста: промежуток меняется каждым
     * сообщением, а строка живёт до конца TTL.
     */
    previousUserMessageAt?: Date | null;
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
    const scoped = input.memoryScopes === undefined ? null : new Set(input.memoryScopes);
    const permits = (scope: string) => scoped === null || scoped.has(scope);
    // Оба запроса задач независимы, поэтому идут одним заходом: путь
    // ответа человеку не должен ждать два round-trip подряд.
    // Момент напоминания и остаток до него считает серверный код: модель
    // берёт такой остаток из головы и ошибается на часы.
    const [taskActivity, upcomingReminders] = permits("tasks")
      ? await Promise.all([
        this.taskEvents.contextLines(input.userId, timezone).catch(() => []),
        this.taskEvents.upcomingLines(input.userId, timezone, local.toJSDate()).catch(() => []),
      ])
      : [[], []];
    const skillLines = await this.options.skillContext?.({ userId: input.userId, conversationId: input.conversationId, purpose: row.purpose, message: input.userMessage, turnId: input.turnId }).catch(() => []);
    return {
      userId: Number(row.user_id),
      telegramId: Number(row.telegram_id),
      agentId: row.agent_id,
      conversationId: row.conversation_id,
      purpose: row.purpose,
      localTime: local.toISO({ suppressMilliseconds: true }) ?? local.toUTC().toISO()!,
      localDate: localDateWithWeekday(local),
      sincePreviousMessage: sincePrevious(local.toJSDate(), input.previousUserMessageAt ?? null),
      timezone,
      city: permits("profile") ? row.city : null,
      countryCode: row.country_code,
      responseLanguage: language.language,
      responseMode: row.response_mode,
      useEmoji: row.use_emoji,
      communicationStyle: permits("profile") ? row.communication_style : null,
      profileHint: permits("profile") ? profileHint : null,
      activeGoal: !permits("goals") || this.options.vectorGoalsEnabled === false
        ? null
        : row.active_goal_title ?? null,
      nextResult: !permits("goals") || this.options.vectorGoalsEnabled === false
        ? null
        : row.next_result_title ?? null,
      nextStep: !permits("goals") || this.options.vectorGoalsEnabled === false
        ? null
        : row.next_action ?? null,
      relevantMemory: (input.relevantMemory ?? []).filter((line) => scoped === null || [...scoped].some((scope) => line.startsWith(`${scope}:`) || line.startsWith(`${scope.replace(/s$/, "")}:`))).slice(0, 5),
      llmQualityMode: input.modelPolicy ?? row.llm_quality_mode,
      taskActivity,
      upcomingReminders,
      skillLines: input.allowedSkills === undefined ? skillLines : input.allowedSkills.length === 0 ? [] : (skillLines ?? []).filter((line) => input.allowedSkills!.some((slug) => line.includes(slug))),
      metrics: {
        runtimeContextMs: elapsed(started),
        profileCheckMs,
        cacheHit: loaded.cacheHit,
      },
    };
  }

  /** Canonical lifecycle event; callers invoke it only after an explicit workflow/tool outcome. */
  async completeSkillScenario(input: {
    userId: number; conversationId: string; purpose: string; turnId?: string;
  }): Promise<void> {
    await this.options.skillContext?.({ ...input, message: "", scenarioComplete: true });
  }

  wrapUserMessage(
    context: RuntimeContext,
    userMessage: string,
    options: {
      messageSource?: MessageSource;
      crisisLevel?: "none" | "low" | "medium" | "high" | "critical";
      internalOperationType?: string;
      correlationId?: string;
      /** Строки уровня знаний: их поставляет гибридный поиск. */
      knowledge?: readonly string[];
      /** Строки активных навыков: их поставит роутер навыков шага 20. */
      skills?: readonly string[];
      /** Куда сложить измеренные размеры уровней. */
      measure?: (levels: LevelMeasurement[]) => void;
    } = {},
  ): string {
    const fields: Array<[string, string | null]> = [
      ["local_time", context.localTime],
      ["local_date", context.localDate],
      // Промежуток и его следствие стоят рядом: голое число модель
      // читает, но не применяет — и поздравляет с делом, на которое
      // прошло девять секунд.
      ["since_previous_user_message", context.sincePreviousMessage],
      [
        "since_previous_user_message_note",
        context.sincePreviousMessage === null
          ? null
          : "Столько прошло между прошлым сообщением человека и этим. Считай этот"
            + " промежуток фактом и не выдумывай его по смыслу слов. Если человек"
            + " сообщает о сделанном, сверься с промежутком: дело, на которое нужны"
            + " десятки минут или часы, за секунды и минуты не делается. В таком"
            + " случае не подтверждай выполнение и не хвали, а спокойно уточни —"
            + " возможно, он имел в виду другое, оговорился или пишет из середины"
            + " дела. Спрашивать о результате того, что заведомо не могло"
            + " состояться, тоже нельзя.",
      ],
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
    if (this.options.vectorGoalsEnabled !== false) {
      lines.push(
        "vector_protocol: черновик цели активируется только после явного подтверждения; действие должно иметь артефакт, первый физический шаг, время, длительность, if-then и критерий завершения; после действия спроси о факте, а при отклонении меняй один элемент и один следующий малый шаг без обвинений",
      );
    }
    // Уровни собираются каждый под своим бюджетом. Общий предел ниже
    // остаётся страховкой, но первым режет не он: иначе длинная память
    // выдавливала бы знания, а знания — события задач.
    const measurements: LevelMeasurement[] = [];
    // Навыки собирает роутер навыков шага 20, и сегодня их набор пуст.
    // Уровень всё равно измеряется: ноль — это измерение, а пропущенный
    // уровень означал бы «не считали», и превышение бюджета навыков
    // всплыло бы только на живом ходу.
    const skills = fitLevel("skills", [...(context.skillLines ?? []), ...(options.skills ?? [])]);
    measurements.push(skills.measurement);
    if (skills.lines.length > 0) lines.push("active_skills:", ...skills.lines);

    const memory = fitLevel(
      "memory",
      context.relevantMemory.map((item) => `  - ${escapeContextValue(item)}`),
    );
    measurements.push(memory.measurement);
    if (memory.lines.length > 0) lines.push("relevant_memory:", ...memory.lines);

    const knowledge = fitLevel(
      "knowledge",
      (options.knowledge ?? []).map((item) => `  - ${escapeContextValue(item)}`),
    );
    measurements.push(knowledge.measurement);
    if (knowledge.lines.length > 0) lines.push("recalled_knowledge:", ...knowledge.lines);

    const conversation = fitLevel(
      "conversation",
      (context.taskActivity ?? []).slice(0, 5).map((item) => `  - ${escapeContextValue(item)}`),
    );
    measurements.push(conversation.measurement);
    if (conversation.lines.length > 0) lines.push("recent_task_events:", ...conversation.lines);

    // Ближайшие напоминания стоят рядом с местным временем и приходят с
    // уже посчитанным остатком: «через сколько» — это арифметика, а её
    // модель делает неверно и уверенно.
    const upcoming = (context.upcomingReminders ?? []).slice(0, 3);
    if (upcoming.length > 0) {
      lines.push(
        "upcoming_reminders:",
        ...upcoming.map((item) => `  - ${escapeContextValue(item)}`),
        "upcoming_reminders_note: время и остаток посчитаны сервером — называй их как есть"
        + " и не пересчитывай в уме",
      );
    }
    const limit = Math.max(1_000, this.options.maxContextCharacters ?? 6_000);
    measurements.unshift({
      level: "always_on",
      characters: lines.join("\n").length - skills.measurement.characters
        - memory.measurement.characters - knowledge.measurement.characters
        - conversation.measurement.characters,
      budget: LEVEL_BUDGETS.always_on,
      dropped: 0,
    });
    context.levels = measurements;
    options.measure?.(measurements);
    // Лимит режет переменную часть: память и подсказки бывают длинными.
    // Указания о форме ответа ниже — фиксированные и обрезке не подлежат:
    // потеряв их, Ева снова начнёт проговаривать план и слать сырые
    // звёздочки, а урезанная память всего лишь чуть беднее.
    const contextBlock = [
      lines.join("\n").slice(0, limit),
      // Модель в агентном цикле склонна проговаривать план вслух
      // («Let me search for both.»), и это уходило пользователю вместе с
      // ответом. Код такое отсекает, но дешевле не порождать.
      "output_protocol: не проговаривай план и ход рассуждений — отправляй только готовый ответ; "
      + "не пересказывай, какими инструментами пользовалась, если об этом не спросили; "
      + "отвечай на языке из response_language",
      // Род держится системным промптом, но на длинном ходу модель
      // соскальзывает в мужской: «понял», «сделал». Напоминание стоит
      // здесь, потому что оно приходит с каждым сообщением, а системный
      // промпт — один раз в начале сессии. Для языков без рода строки нет:
      // платить за неё в каждом ходу незачем.
      ...(context.responseLanguage === "ru"
        ? ["self_reference: Ева — женщина и говорит о себе только в женском роде: "
          + "«поняла», «сделала», «посмотрела», «нашла», «записала», «рада», «готова»; "
          + "формы «понял», «сделал», «посмотрел», «нашёл», «записал», «рад», «готов» о себе запрещены"]
        : []),
      // Telegram принимает подмножество markdown. Раньше parse_mode не
      // ставился вовсе и звёздочки были видны как есть; теперь ответ
      // переводится в HTML, и разметкой можно пользоваться.
      "formatting: доступны **жирный**, *курсив*, `код`, блоки ```кода```, списки через «-», "
      + "нумерованные списки и ссылки вида [текст](url); заголовок «#» станет жирной строкой; "
      + "«> текст» — цитата для главного вывода, «>> текст» — сворачиваемая для длинных "
      + "пояснений, «||текст||» — скрытый текст, открывается нажатием; "
      + "таблицы и вложенные списки Telegram не поддерживает — не используй их",
      "layout: в цитату «>» помещай только один главный вывод на сообщение; в «||скрытый||» — "
      + "второстепенные подробности и осторожные интерпретации, но никогда предупреждения, "
      + "кризисные рекомендации, сроки, стоимость и обязательные действия; в «>>» — длинные "
      + "объяснения вместо перегруженного сообщения; абзацы по 1–3 предложения; эмодзи 1–3 "
      + "на сообщение; короткий ответ в одну-две фразы оформлением не перегружай; "
      + "вопрос к пользователю ставь последним отдельным абзацем",
      // Инструмент есть давно, но модель о нём не вспоминала.
      "reactions: есть инструмент set_reaction — ставь эмодзи-реакцию на сообщение пользователя, "
      + "когда она уместна по контексту (согласие, поддержка, шутка, важная новость); "
      + "не ставь её на каждое сообщение и не заменяй ей ответ",
    ].join("\n");
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
      crisis_level: options.crisisLevel ?? "none",
      user_mode: context.llmQualityMode ?? "auto",
      internal_operation_type: options.internalOperationType,
      correlation_id: options.correlationId,
      related_goals: context.activeGoal ? 1 : 0,
      related_tasks: context.taskActivity?.length ? 1 : 0,
      related_recent_events: context.taskActivity?.length ?? 0,
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
