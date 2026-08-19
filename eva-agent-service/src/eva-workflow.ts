import type { Config } from "./config.js";
import { type CrisisMonitor, safetyDirective } from "./crisis.js";
import type { AgentLinkRow, Database, SttUsageAttempt, UserRow } from "./db.js";
import type { InboxResult } from "./delivery/inbox.js";
import { EvaError } from "./errors.js";
import { preferredResponseLanguage, t } from "./i18n/index.js";
import type { SupportedLanguage } from "./i18n/language-resolver.js";
import type { LettaService } from "./letta.js";
import type { LlmManager } from "./llm.js";
import type { Logger } from "./logger.js";
import type { ChannelLinkService } from "./channels/channel-links.js";
import type { UserProfileService } from "./profile/profile-service.js";
import type { UserTurnLock } from "./turns/user-turn-lock.js";
import type { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import type { SendMessage } from "@letta-ai/letta-agent-sdk";
import { TaskEventService } from "./tasks/task-event-service.js";
import { withSpan } from "./observability/tracing.js";
import {
  closeTurnScope,
  openTurnScope,
  runInTurn,
  type ActiveTurn,
} from "./turns/turn-context.js";
import {
  messageBatchTiming,
  timelineDetail,
  type MessageBatchTiming,
} from "./turns/message-timeline.js";
import {
  TURN_FLOW_VERSION,
  type TurnHandle,
  type TurnLifecycle,
  type TurnLinks,
} from "./turns/turn-lifecycle.js";
import {
  type TelegramLiveMessage,
  type TelegramMessage,
  type TelegramUpdate,
  TelegramClient,
  telegramMessageIdOf,
  TelegramFileTooLarge,
} from "./telegram.js";
import {
  AttachmentError,
  TelegramAttachmentReader,
  audioFileOf,
  imageFileOf,
  telegramMediaKind,
  type AttachmentImage,
} from "./attachments/telegram-attachments.js";

/**
 * Распознавание не удалось.
 *
 * Отдельный тип, а не обычный Error, чтобы обработчик мог ответить
 * пользователю понятной фразой вместо общего «что-то пошло не так».
 * Техническая причина остаётся в message и уходит только в лог.
 */
export class VoiceTranscriptionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "VoiceTranscriptionError";
  }
}

/**
 * Сколько текст ждёт голос в режиме «голос и текст».
 *
 * Синтез длинного ответа занимает секунды, и пока он идёт, человеку
 * виден обновляющийся черновик. Срок — потолок, а не расчёт: за ним
 * молчание перестаёт читаться как «Ева печатает», и текст уходит без
 * голоса, который догоняет его отдельным сообщением.
 */
const VOICE_SYNC_BUDGET_MS = 45_000;

/**
 * Ждёт результат не дольше срока. `null` означает «ещё не готово», а не
 * «не будет»: работа продолжается, и вызывающий может дождаться её
 * позже. Таймер снимается в любом исходе — иначе процесс держал бы
 * событие до конца срока на каждом ходе.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Кто ведёт ход. Аренда сама по себе ничего не сериализует — она
 * отвечает на вопрос «чей это ход был», когда процесс перезапустился и
 * незавершённые записи надо разобрать.
 */
const LEASE_OWNER = `eva-agent-service:${process.pid}`;

/**
 * Сколько изображений уходит в один ход.
 *
 * Ограничение не про вежливость, а про контекст: каждая картинка стоит
 * тысяч токенов, и десяток снимков в одном окне вытеснит из контекста
 * сам разговор.
 */
const MAX_IMAGES_PER_TURN = 4;

import {
  inlineKeyboard,
  newCallbackToken,
  type InlineChoiceIntent,
} from "./telegram/inline-choices.js";
import { namedOptions } from "./telegram/polls.js";

/**
 * Сколько живёт кнопка под ответом.
 *
 * Сутки: разговор возвращается к вчерашнему вопросу, и кнопка, умершая
 * через час, выглядит поломкой. Дольше держать незачем — выбор из
 * позавчерашнего ответа уже не про текущий разговор.
 */
const CALLBACK_TOKEN_TTL_SECONDS = 24 * 60 * 60;


interface NormalizedUpdate {
  updateId: number;
  message: TelegramMessage;
  telegramId: number;
  chatId: number;
  messageId: number;
  kind: "text" | "voice" | "image" | "document" | "unsupported";
  command: string | null;
  replyToMessageId: number | null;
}

export class EvaWorkflow {
  private readonly taskEvents: TaskEventService;
  /** Разбор вложений: общий с приёмом в базу знаний. */
  private readonly attachments: TelegramAttachmentReader;
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly llm: LlmManager,
    private readonly queue: UserTurnLock,
    private readonly telegram: TelegramClient,
    private readonly runtimeContext: RuntimeContextBuilder,
    private readonly profile: UserProfileService,
    private readonly logger: Logger,
    private readonly crisis?: CrisisMonitor,
    /**
     * Наблюдатель хода. Необязателен намеренно: без него путь обработки
     * сообщения тот же самый, что и до этого шага.
     */
    private readonly turns?: TurnLifecycle,
    /**
     * Связь сообщения канала с ходом и conversation (шаг 25, пункт 2).
     * Отсутствие сервиса допустимо: связь — вспомогательная запись, и
     * ход без неё выполняется как прежде.
     */
    private readonly channelLinks?: ChannelLinkService,
    /**
     * Доставка канонической персоны агенту, который её ещё не получил.
     * Необязательна: без неё ход идёт как прежде, просто устаревший агент
     * остаётся устаревшим до массовой синхронизации.
     */
    private readonly personaSync?: {
      syncAgent(
        input: { agentId: string; userId: number; storedVersion: string | null },
        persona: string,
        options?: { timeoutMs?: number },
      ): Promise<"updated" | "up_to_date" | "failed" | "disabled">;
      persona(): string;
    },
  ) {
    this.taskEvents = new TaskEventService(db);
    this.attachments = new TelegramAttachmentReader(telegram);
  }

  /**
   * Ход прекращён до обращения к модели: блокировка, исчерпанная квота,
   * неподдерживаемое сообщение, команда. Ответ пользователю при этом
   * отправляется — прекращён именно ход модели, а не диалог.
   */
  private async stopTurn(handle: TurnHandle | null, reason: string): Promise<void> {
    if (!handle || !this.turns) return;
    await this.turns.requestCancel(handle, reason);
    await this.turns.transition(handle, "cancelling", { detail: { reason } });
    await this.turns.transition(handle, "cancelled");
  }

  private async linkTurn(handle: TurnHandle | null, links: TurnLinks): Promise<void> {
    if (!handle || !this.turns) return;
    await this.turns.link(handle, links);
  }

  private async moveTurn(
    handle: TurnHandle | null,
    to: Parameters<TurnLifecycle["transition"]>[1],
    options: Parameters<TurnLifecycle["transition"]>[2] = {},
  ): Promise<void> {
    if (!handle || !this.turns) return;
    await this.turns.transition(handle, to, options);
  }

  /** Awaitable entry point used by tests and controlled reprocessing. */
  async handle(update: TelegramUpdate): Promise<void> {
    await this.processQueued(update);
  }

  /** The durable inbox is the only production caller of this method. */
  async processQueued(update: TelegramUpdate): Promise<InboxResult> {
    return await this.processAggregated([update]);
  }

  /**
   * Превратить нажатие кнопки и голос в опросе в обычное сообщение.
   *
   * Разбор стоит здесь, а не в `processQueued`: последовательный воркер
   * и параллельный диспетчер входят в ход разными дверями, и разбор
   * только в одной из них означал бы, что при включённом параллельном
   * приёме кнопки и опросы молча перестают работать.
   *
   * Апдейт, который разобрать не удалось, ходом не становится: чужая
   * кнопка, повторный голос и просроченный токен — это не сообщение.
   */
  private async resolveSpecial(update: TelegramUpdate): Promise<TelegramUpdate | null> {
    if (update.callback_query) return await this.resolveCallback(update.callback_query);
    if (update.poll_answer) return await this.resolvePollAnswer(update.poll_answer);
    return update;
  }

  /**
   * Превратить голос в опросе в сообщение человека.
   *
   * Тексты вариантов берутся из серверной записи опроса, а из апдейта —
   * только их номера: Telegram присылает индексы, и подставлять вместо
   * них что-то другое значило бы отдать выбор смысла клиенту.
   *
   * Владелец сверяется дважды: опрос должен быть заведён Евой, а
   * отвечающий — быть тем же человеком, которому он отправлен. Чужой
   * голос в разговор не попадает.
   */
  private async resolvePollAnswer(
    answer: NonNullable<TelegramUpdate["poll_answer"]>,
  ): Promise<TelegramUpdate | null> {
    const telegramId = answer.user?.id;
    const pollId = typeof answer.poll_id === "string" ? answer.poll_id.trim() : "";
    // Анонимный опрос автора не называет вовсе — связывать нечего.
    if (!Number.isSafeInteger(telegramId) || !pollId) return null;

    const poll = await this.db.findPollByTelegramId(pollId);
    if (!poll) return null;
    // Опрос, заведённый анонимным, не приписывается человеку, даже если
    // автор в апдейте всё-таки назван. Сегодня Telegram его не называет,
    // но правило «анонимный ответ ни с кем не связан» держится нашей
    // записью, а не поведением чужой стороны.
    if (poll.isAnonymous) return null;
    const user = await this.db.findUserByTelegramId(telegramId!);
    if (!user || user.id !== poll.userId) return null;

    const optionIds = [...new Set(
      (answer.option_ids ?? []).filter((id) => Number.isSafeInteger(id)),
    )].sort((left, right) => left - right);
    const recorded = await this.db.recordPollAnswer({
      userId: user.id, pollId, optionIds,
    });
    if (recorded.status === "duplicate") {
      // Тот же апдейт пришёл повторно или человек нажал тот же вариант:
      // второго хода за один и тот же выбор не заводим.
      return null;
    }
    const chosen = namedOptions(poll.options, optionIds);
    // Голос отозван: сказать разговору нечего, а «ничего не выбрано»
    // ходом не является.
    if (chosen.length === 0) return null;

    return {
      update_id: -1,
      message: {
        message_id: poll.messageId ?? 0,
        date: Math.floor(Date.now() / 1000),
        chat: { id: poll.chatId, type: "private" },
        from: { id: telegramId!, is_bot: false },
        text: `Ответ в опросе «${poll.question}»: ${chosen.join(", ")}`,
      } as TelegramMessage,
    };
  }

  /**
   * Превратить нажатие кнопки в сообщение человека.
   *
   * Ни строки из `callback_data` в разговор не попадает: это токен, и
   * значение выбора берётся из серверной записи, сделанной при отправке
   * кнопок. Иначе нажатие было бы способом продиктовать Еве произвольный
   * текст от имени человека.
   *
   * Telegram отвечаем первым делом: пока ответа нет, на кнопке крутится
   * ожидание, и это единственное, что человек видит.
   */
  private async resolveCallback(
    callback: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<TelegramUpdate | null> {
    await this.telegram.answerCallbackQuery(callback.id).catch(() => undefined);
    const telegramId = callback.from?.id;
    const token = callback.data;
    if (!Number.isSafeInteger(telegramId) || !token) return null;

    const user = await this.db.findUserByTelegramId(telegramId!);
    if (!user) return null;
    const claim = await this.db.claimCallbackToken({ token, userId: user.id });
    if (claim.status !== "claimed") {
      // Повторный клик, чужая или просроченная кнопка — молча ничего.
      // Второго хода не заводим: выбор уже сделан либо не наш.
      this.logger.info("Нажатие кнопки не стало ходом", {
        telegramId, outcome: claim.status,
      });
      return null;
    }

    if (claim.oneShot && claim.messageId !== null) {
      // Кнопки одноразовые: снимаем их, чтобы под ответом не осталось
      // выбора, который уже сделан.
      await this.db.expireCallbackTokensOfMessage({
        userId: user.id, chatId: claim.chatId, messageId: claim.messageId,
      });
      await this.telegram
        .clearInlineKeyboard(claim.chatId, claim.messageId)
        .catch(() => undefined);
    }

    return {
      update_id: -1,
      message: {
        message_id: claim.messageId ?? 0,
        date: Math.floor(Date.now() / 1000),
        chat: { id: claim.chatId, type: "private" },
        from: { id: telegramId!, is_bot: false },
        text: claim.value,
      } as TelegramMessage,
    };
  }

  /**
   * Объединённый ход: несколько быстрых сообщений одного человека
   * отвечаются одним ходом.
   *
   * Отвечаем на последнее сообщение — оно и есть та реплика, которую
   * человек дописывал; предыдущие входят в тот же промпт перед ним.
   * Квота снимается один раз: ход один.
   */
  async processAggregated(updates: TelegramUpdate[]): Promise<InboxResult> {
    // Кнопка и опрос становятся обычным сообщением здесь: дальше идёт
    // тот же ход, тот же замок пользователя, те же квоты и тот же
    // порядок, что и у написанного текста.
    const incoming: TelegramUpdate[] = [];
    for (const update of updates) {
      const resolved = await this.resolveSpecial(update);
      if (resolved) incoming.push(resolved);
    }
    const normalized = incoming
      .map((update) => normalizeUpdate(update))
      .filter((item): item is NormalizedUpdate => item !== null);
    if (normalized.length === 0) return { status: "ignored" };
    const primary = normalized[normalized.length - 1]!;
    const earlier = normalized.slice(0, -1);
    // Спан хода открывается здесь и накрывает всё, что ход делает
    // дальше: обращение к Letta, обращения к модели через Router,
    // постановку заданий и доставку. Контекст OpenTelemetry живёт в
    // AsyncLocalStorage и переживает вложенные await, поэтому один
    // идентификатор трассы связывает участки без ручной передачи через
    // каждый вызов.
    //
    // Correlation id выводится из идентификатора апдейта, а не из
    // HTTP-запроса: между вебхуком и этим кодом стоит durable inbox, и
    // ход может выполняться в другом процессе и позже. Идентификатор
    // апдейта переживает и то, и другое.
    const correlationId = `telegram-update:${primary.updateId}`;
    return await withSpan(
      "turn.telegram",
      async () => await this.telegram.withDeliveryContext(
        `${primary.command ? "telegram-command" : "telegram-update"}:${primary.updateId}`,
        async () => await this.process(primary, earlier),
      ),
      {
        // Атрибуты спана здесь заведомо безопасны: идентификатор
        // апдейта и вид источника. Процессор приватности не
        // подключается, чтобы не тащить его в конструктор всех
        // вызывающих ради двух полей, которые и так не содержат
        // пользовательского текста.
        attributes: {
          correlation_id: correlationId,
          source: primary.command ? "command" : "message",
        },
      },
    );
  }

  private async process(
    update: NormalizedUpdate,
    earlier: NormalizedUpdate[] = [],
  ): Promise<InboxResult> {
    // Останов — единственное, что прерывает уже идущий ход. Он не встаёт
    // в очередь за ним: слот пользователя занят как раз тем ходом,
    // который надо прервать, и просьба остановиться дождалась бы его
    // конца — то есть не остановила бы ничего.
    if (update.command === "/stop") return await this.stopRunningTurn(update);
    const typing: { stop: (() => void) | null } = { stop: null };
    // Ответ, который растёт на глазах: одно сообщение, которое правится
    // по мере генерации. Его конец — общий `finally`, каким бы ни был
    // исход хода.
    const live: { current: TelegramLiveMessage | null } = { current: null };
    const started = performance.now();
    // Разложение задержки по этапам. Пока ход мерился одним числом,
    // «Ева долго отвечает» нечем было разобрать: очередь, сборка
    // контекста, ожидание сессии, генерация, синтез речи и доставка
    // лечатся разным, а сумма их не различает.
    const metrics = {
      /** Сколько ход ждал слот пользователя. */
      queue_wait_ms: 0,
      /** Сборка продуктового контекста хода. */
      context_build_ms: 0,
      profile_check_ms: 0,
      // Измеренный размер контекста: сумма фактических размеров уровней.
      context_characters: 0,
      /** Ожидание свободной сессии Letta внутри хода. */
      session_acquire_ms: 0,
      /** Через сколько после отправки пришёл первый текст: то, что человек ощущает. */
      time_to_first_delta_ms: 0,
      /** Генерация целиком, включая вызовы инструментов. */
      letta_generation_ms: 0,
      /** Синтез речи. Идёт параллельно доставке текста и её не задерживает. */
      tts_ms: 0,
      /** Доставка ответа в Telegram: от готового текста до отправленного сообщения. */
      telegram_delivery_ms: 0,
      outbox_insert_ms: 0,
      telegram_send_ms: 0,
      total_turn_ms: 0,
      db_query_count: 0,
    };
    // Ход открывается до очереди: ожидание в ней — часть хода, и без
    // этой записи оно осталось бы невидимым. Запись теневая: ответ
    // пользователю от неё не зависит, а её сбой ход не роняет.
    const turnHandle = this.turns
      ? await this.turns.start({
        channel: "telegram",
        eventId: update.updateId,
        updateId: update.updateId,
        telegramUserId: update.telegramId,
        traceId: `telegram-update:${update.updateId}`,
      })
      : null;
    await this.linkTurn(turnHandle, {
      flowVersion: TURN_FLOW_VERSION,
      promptVersion: this.letta.promptVersion,
    });
    // Объединённый ход проходит через `aggregating`: окно ожидания
    // быстрых сообщений — это часть хода, а не пауза перед ним.
    //
    // Отметки сообщений записываются здесь целиком: идентификаторы,
    // время отправки и промежутки. Раньше от окна оставалось одно число
    // — сколько сообщений в нём было, — и разобрать «эти два пришли с
    // разницей в секунду» было уже нечем. Текста в записи нет.
    const windowTiming = messageBatchTiming(
      [...earlier, update].map((part) => ({
        messageId: part.messageId,
        date: part.message.date,
      })),
      new Date(),
    );
    if (earlier.length > 0) {
      await this.moveTurn(turnHandle, "aggregating", {
        detail: timelineDetail(windowTiming),
      });
    }
    await this.moveTurn(turnHandle, "queued");
    try {
      const measured = await this.db.withQueryMetrics(async () =>
        await this.queue.run(update.telegramId, async (): Promise<InboxResult> => {
        metrics.queue_wait_ms = elapsed(started);
        if (this.turns && turnHandle) {
          // Слот пользователя получен: сколько ход его ждал и кто теперь
          // его ведёт. Аренда нужна восстановлению после перезапуска.
          await this.turns.recordWait(turnHandle, metrics.queue_wait_ms);
          await this.turns.transition(turnHandle, "claimed");
          await this.turns.lease(turnHandle, LEASE_OWNER, this.config.lockTtlSeconds);
        }
        // Ход целиком идёт в области своего пользователя: всё, что
        // выполнится внутри — контекст, инструменты, память, доставка —
        // ограничено этим человеком. Область открывается по проверенному
        // Telegram-идентификатору, внутренний `users.id` добавляется
        // после канонической выборки.
        return await this.db.withUserScope(
          { telegramId: update.telegramId, label: "telegram.turn" },
          async (): Promise<InboxResult> => {
        const { user, link } = await this.ensureUserAndAgent(update);
        const language = preferredResponseLanguage(user);
        // Владельца получает каждая запись окна, а не только та, на
        // которую отвечаем: иначе присоединённые строки остались бы без
        // `user_id` и выпали из выборок по внутреннему идентификатору.
        for (const part of [...earlier, update]) {
          await this.db.attachTelegramUpdateToUser(part.updateId, user.id);
        }
        await this.linkTurn(turnHandle, {
          userId: user.id,
          agentId: link.agent_id,
          conversationId: link.conversation_id,
          purpose: "chat",
        });

        // Персона агента доводится до канонической до самого хода.
        // Массовая синхронизация идёт при старте и может не успеть к
        // первому сообщению человека, а агент со старым текстом успеет
        // ответить о себе в мужском роде. Проход ограничен по времени и
        // ход не роняет: молчащий control plane — не повод не ответить.
        if (this.personaSync) {
          const storedVersion = typeof link.meta?.persona_version === "string"
            ? link.meta.persona_version
            : null;
          await this.personaSync.syncAgent(
            { agentId: link.agent_id, userId: user.id, storedVersion },
            this.personaSync.persona(),
            { timeoutMs: this.config.personaSyncTurnTimeoutMs },
          ).catch(() => undefined);
        }

        if (user.is_blocked || user.state === "blocked") {
          await this.telegram.sendMessage(update.chatId, t(language, "accessBlocked"));
          await this.stopTurn(turnHandle, "user_blocked");
          return { status: "ignored" };
        }

        if (update.command) {
          await this.handleCommand(update, user, language);
          await this.stopTurn(turnHandle, "command");
          return { status: "completed" };
        }

        if (update.kind === "unsupported") {
          await this.telegram.sendMessage(
            update.chatId,
            t(language, "unsupportedMessage"),
          );
          await this.stopTurn(turnHandle, "unsupported_message");
          return { status: "ignored" };
        }

        const quota = await this.db.getQuotaStatus(update.telegramId);
        const messageQuota = quota.find((item) => item.metric === "messages") as
          | { remaining?: number | string | null; limit_value?: number | string }
          | undefined;
        if (
          messageQuota?.remaining !== null &&
          messageQuota?.remaining !== undefined &&
          Number(messageQuota.remaining) <= 0
        ) {
          await this.telegram.sendMessage(
            update.chatId,
            t(language, "messageQuotaEnded"),
          );
          await this.stopTurn(turnHandle, "quota_messages");
          return { status: "ignored" };
        }
        // Голос проверяется по всему окну, а не по последнему сообщению.
        // Расшифровываются и списывают минуты все части объединённого
        // хода, поэтому «голосовое плюс короткий текст» иначе проходило
        // бы мимо гейта и тратило минуты сверх исчерпанной квоты.
        let parts = [...earlier, update];
        if (parts.some((part) => part.kind === "voice")) {
          const voiceQuota = quota.find((item) => item.metric === "voice_minutes") as
            | { remaining?: number | string | null }
            | undefined;
          if (
            voiceQuota?.remaining !== null &&
            voiceQuota?.remaining !== undefined &&
            Number(voiceQuota.remaining) <= 0
          ) {
            await this.telegram.sendMessage(
              update.chatId,
              t(language, "voiceQuotaEnded"),
            );
            // Голосовые части выпадают, текстовые остаются. Прекратить
            // ход целиком значило бы потерять текст, который человек
            // написал в том же окне: последовательный воркер на него
            // ответил бы, потому что гейтил каждое сообщение отдельно.
            parts = parts.filter((part) => part.kind !== "voice");
            if (parts.length === 0) {
              await this.stopTurn(turnHandle, "quota_voice");
              return { status: "ignored" };
            }
          }
        }

        let prompt: string;
        // Содержимое вложений едет отдельно от реплики человека: подпись
        // к файлу — его слова, а сам файл — данные.
        const attachments: string[] = [];
        const images: AttachmentImage[] = [];
        try {
          // Порядок сообщений сохраняется: человек дописывал мысль, и
          // прочитать её задом наперёд — значит прочитать другую мысль.
          const texts: string[] = [];
          for (const part of parts) {
            const collected = await this.promptFromMessage(part);
            const text = collected.text.trim();
            if (text) texts.push(text);
            attachments.push(...collected.attachments);
            images.push(...collected.images);
          }
          prompt = texts.join("\n");
        } catch (error) {
          // Провал распознавания — не сбой Евы: разговор продолжается,
          // просто этим сообщением. Технический текст провайдера сюда
          // не попадает, он остался в логе.
          if (error instanceof VoiceTranscriptionError) {
            await this.telegram.sendMessage(update.chatId, t(language, "voiceFailed"));
            await this.stopTurn(turnHandle, "voice_transcription_failed");
            return { status: "ignored" };
          }
          // Вложение, которое не прочиталось, — это ответ человеку, а не
          // сбой Евы: он должен узнать, что именно не так с файлом.
          if (error instanceof AttachmentError || error instanceof TelegramFileTooLarge) {
            this.logger.info("Вложение не прочитано", {
              telegram_id: update.telegramId,
              code: error instanceof AttachmentError ? error.code : "attachment_too_large",
            });
            await this.telegram.sendMessage(
              update.chatId,
              error instanceof AttachmentError ? error.message : t(language, "attachmentTooLarge"),
            );
            await this.stopTurn(turnHandle, "attachment_rejected");
            return { status: "ignored" };
          }
          throw error;
        }
        if (update.replyToMessageId !== null) {
          const linked = await this.taskEvents.findByTelegramReply(
            user.id,
            update.chatId,
            update.replyToMessageId,
          );
          if (linked) {
            await this.taskEvents.record({
              userId: user.id,
              taskId: linked.task_id,
              eventType: "user_replied",
              telegramChatId: update.chatId,
              telegramMessageId: update.messageId,
              metadata: { reply_to_message_id: update.replyToMessageId },
            });
            const replyText = prompt.trim().toLocaleLowerCase("ru");
            if (/^(сделал(?:а)?|готово|выполнено|done)[!.\s]*$/u.test(replyText)) {
              await this.taskEvents.complete(user.id, Number(linked.task_id));
            } else if (/^(отмени|отменить|cancel)[!.\s]*$/u.test(replyText)) {
              await this.taskEvents.cancel(user.id, Number(linked.task_id));
            } else if (/^(завтра|tomorrow)[!.\s]*$/u.test(replyText)) {
              await this.taskEvents.snooze(
                user.id,
                Number(linked.task_id),
                new Date(Date.now() + 24 * 60 * 60_000),
              );
            }
            prompt = [
              "<REPLIED_TASK>",
              `task_id: ${linked.task_id}`,
              `title: ${linked.title}`,
              `status_before_reply: ${linked.status}`,
              "Пользователь ответил именно на сообщение-напоминание этой задачи.",
              "</REPLIED_TASK>",
              prompt,
            ].join("\n");
          }
        } else if (/^(сделал(?:а)?|готово|выполнено|не успел(?:а)?|перенеси|завтра|отмени|done|cancel|tomorrow)[!.\s]*$/iu.test(prompt.trim())) {
          const candidates = await this.taskEvents.recentOpenReminderTasks(user.id, 3);
          if (candidates.length > 1) {
            prompt = [
              "<AMBIGUOUS_TASK_REPLY>",
              "Сообщение не является Telegram reply, а подходят несколько недавних задач.",
              `Кандидаты: ${candidates.map((item) => item.title).join("; ")}`,
              "Не угадывай и не изменяй задачи. Сначала уточни, какую задачу имеет в виду пользователь.",
              "</AMBIGUOUS_TASK_REPLY>",
              prompt,
            ].join("\n");
          }
        }
        typing.stop = this.telegram.startTyping(update.chatId, this.config.typingIntervalMs);
        // Окно этого хода после гейтов: голосовая часть могла выпасть по
        // квоте, и рассказывать про неё в контексте больше нечего.
        const promptTiming: MessageBatchTiming = messageBatchTiming(
          parts.map((part) => ({ messageId: part.messageId, date: part.message.date })),
          new Date(),
        );
        // Отметка предыдущего сообщения нужна контексту: по ней считается
        // промежуток между сообщениями. Читается она здесь, потому что
        // этот же запрос её и перезаписывает.
        //
        // Записывается время последнего сообщения человека, а не момент
        // обработки: между отправкой и ходом стоит durable inbox, и
        // очередь добавляла к промежутку следующего хода своё ожидание.
        const previousUserMessageAt = await this.db.recordUserMessage(
          user.id,
          promptTiming.lastAt,
        );
        const conversationId = link.conversation_id;
        if (!conversationId) throw new Error("У агента отсутствует активный conversation");
        // Сообщение Telegram связывается с тем же ходом и той же
        // conversation, что и действие из Mini App. Ключ — пара
        // «чат:сообщение»: идентификатор сообщения уникален внутри
        // чата, а не глобально.
        //
        // Отказ здесь не срывает ход: связь нужна, чтобы показать
        // человеку его же действие в другом канале, и потеря одной
        // строки не стоит потерянного ответа.
        if (this.channelLinks) {
          await this.channelLinks.link(user.id, {
            channel: "telegram",
            channelMessageId: `${update.chatId}:${update.messageId}`,
            turnId: turnHandle?.runId ?? null,
            conversationId,
          }).catch((error) => this.logger.debug("Связь канала не записана", {
            userId: user.id,
            reason: error instanceof Error ? error.message : "unknown",
          }));
        }

        await this.moveTurn(turnHandle, "context_building");
        const context = await this.runtimeContext.build({
          userId: user.id,
          conversationId,
          userMessage: prompt,
          languageMessage:
            update.message.text?.trim() ||
            update.message.caption?.trim() ||
            (update.kind === "voice" ? prompt : ""),
          turnId: turnHandle?.runId,
          previousUserMessageAt,
          currentMessageAt: promptTiming.firstAt,
          messageBatch: promptTiming,
        });
        metrics.context_build_ms = context.metrics?.runtimeContextMs ?? 0;
        metrics.profile_check_ms = context.metrics?.profileCheckMs ?? 0;
        const responseMode = context.responseMode;
        // Текст, показанный человеку прямо сейчас: он же сверяется с
        // итоговым ответом перед отправкой.
        let streamed = "";
        if (responseMode === "text" || responseMode === "both") {
          // Ничего не отправляется, пока модель не прислала первый
          // содержательный срез: до этого момента человек видит «Ева
          // печатает», а поле ввода остаётся свободным.
          live.current = this.telegram.startLiveMessage(update.chatId, {
            onSent: () => {
              // Сообщение появилось — «печатает» становится враньём.
              typing.stop?.();
              typing.stop = null;
            },
          });
        }
        const stream = live.current;
        // Recorded and escalated before the turn runs, so a disclosure
        // survives even if the model's answer is slow, truncated or unhelpful.
        const signal = await this.crisis?.inspect({
          userId: user.id,
          telegramId: update.telegramId,
          text: prompt,
        });

        await this.moveTurn(turnHandle, "context_built");
        // Барьер отмены до обращения к модели: отменённый ход не платит
        // за генерацию, которую всё равно не покажет.
        if (turnHandle && this.turns && await this.turns.isCancelled(turnHandle)) {
          await this.moveTurn(turnHandle, "cancelling", { detail: { reason: "cancelled" } });
          await this.moveTurn(turnHandle, "cancelled");
          return { status: "ignored" };
        }
        // Сообщение уходит в App Server, и до его ответа ход находится
        // в обработке модели. Обе отметки ставятся здесь: промежуточной
        // точки наблюдения один вызов SDK не даёт.
        await this.moveTurn(turnHandle, "sent_to_letta");
        await this.moveTurn(turnHandle, "letta_processing");
        const lettaStarted = performance.now();
        let answer;
        // Оформление, о котором Ева попросила инструментом. Снимается
        // изнутри хода: контекст хода живёт только пока идёт обращение к
        // Letta, а кнопки приклеиваются позже, на доставке.
        let uiIntent: InlineChoiceIntent | null = null;
        try {
          // Ход выполняется внутри своего контекста: инструменты узнают
          // из него `run_id` и барьер отмены, не получая их параметром
          // через чужой код Agent SDK.
          // Объект хода создаётся отдельно: оформление, о котором Ева
          // попросит инструментом, останется в нём, и прочитать его надо
          // уже после хода — на доставке контекста хода больше нет.
          const activeTurn: ActiveTurn = {
            runId: turnHandle?.runId ?? "",
            recorded: turnHandle?.recorded === true,
            isCancelled: async () =>
              turnHandle && this.turns ? await this.turns.isCancelled(turnHandle) : false,
            // Сообщение этого хода: на него ставится реакция. У
            // объединённого хода — последнее сообщение окна, то самое,
            // на которое Ева и отвечает.
            chatId: update.chatId,
            messageId: parts[parts.length - 1]?.messageId ?? update.messageId,
          };
          // Второй адрес того же хода: инструменты вызываются из
          // обработчика сокета SDK, куда контекст не доезжает.
          openTurnScope(conversationId, activeTurn);
          answer = await runInTurn(
            activeTurn,
            async () => await this.letta.runTurn(
              conversationId,
              this.messageForLetta(
                this.runtimeContext.wrapUserMessage(
                context,
                signal ? `${safetyDirective(signal)}\n\n${prompt}` : prompt,
                {
                  messageSource: update.kind,
                  attachments,
                  // Фактический размер собранного контекста, а не
                  // обещание уложиться: без измерения бюджет — это
                  // намерение.
                  measure: (characters) => { metrics.context_characters = characters; },
                },
                ),
                images,
              ),
              {
                isCancelled: async () =>
                  turnHandle && this.turns ? await this.turns.isCancelled(turnHandle) : false,
                // Ответ показывается по мере генерации. Срез, открывающий
                // новое сообщение, стирает показанное: до ответа человеку
                // модель проговаривает, что собирается сделать, и это
                // проговаривание ответом не является.
                onDelta: stream
                  ? (delta) => {
                    // Новая группа — новое сообщение модели: то, что она
                    // проговаривала до вызова инструмента, ответом не
                    // является и к нему не приклеивается.
                    if (delta.startsGroup) streamed = "";
                    streamed += delta.text;
                    stream?.push(streamed);
                  }
                  : undefined,
              },
            ),
          );
          // Что попросил инструмент внутри хода — забираем сразу:
          // дальше контекст хода уже закрыт.
          uiIntent = activeTurn.ui?.inlineChoices ?? null;
        } catch (error) {
          // Отменённый ход не доставляет поздний ответ и не идёт в
          // повтор: он закончился по просьбе, а не по ошибке.
          if (error instanceof EvaError && error.code === "turn_cancelled") {
            await this.moveTurn(turnHandle, "cancelling", { detail: { reason: "cancelled" } });
            await this.moveTurn(turnHandle, "cancelled");
            live.current?.stop();
            live.current = null;
            return { status: "ignored" };
          }
          throw error;
        } finally {
          metrics.letta_generation_ms = elapsed(lettaStarted);
          // Ход закончился любым исходом — адрес по conversation
          // снимается здесь. Отменённый или упавший ход не должен
          // оставить после себя запись, в которую попадёт следующий.
          closeTurnScope(conversationId);
        }
        metrics.session_acquire_ms = answer.sessionAcquireMs;
        metrics.time_to_first_delta_ms = answer.firstDeltaMs ?? 0;
        await this.moveTurn(turnHandle, "result_received", {
          // Только счётчики: ни аргументов инструментов, ни текста.
          detail: { tool_calls: answer.toolCalls.length },
        });
        // Факт вызова инструмента — единственное, чем можно подтвердить,
        // что Ева открывала навык. Её собственные слова об этом такой же
        // текст, как любой другой. Запись метаданных не должна ронять
        // ход: телеметрия важна, но не важнее ответа человеку.
        try {
          await this.db.recordAgentToolCalls(
            user.id,
            answer.conversationId,
            answer.toolCallRecords,
          );
        } catch (error) {
          this.logger.warn("Вызовы инструментов не записаны", {
            userId: user.id,
            code: error instanceof Error ? error.name : "unknown_error",
          });
        }
        // Отдельного идентификатора сессии Agent SDK не отдаёт: сессия
        // адресуется conversation, им и связываем.
        await this.linkTurn(turnHandle, {
          lettaSessionId: answer.conversationId,
          // Идентификаторы run отдаёт сам SDK. Не сохранять их значит
          // выбрасывать единственное свидетельство, по которому ход
          // опознаётся на стороне Letta.
          lettaRunIds: answer.runIds,
        });
        await this.db.markAgentUsed(link.agent_id, user.id);
        // Ход, где модель прислала несколько сообщений, — это агентный
        // цикл с проговариванием плана. В Telegram уходит только
        // последнее; счётчики нужны, чтобы разбирать жалобы на утёкшие
        // рассуждения по факту, а не по догадке. Текста здесь нет
        // намеренно: содержимое разговора в логи не попадает.
        if (answer.assistantGroups > 1 || !answer.assistantHadIds) {
          this.logger.info("Ход состоял из нескольких сообщений модели", {
            userId: user.id,
            assistant_groups: answer.assistantGroups,
            slice_ids_present: answer.assistantHadIds,
            tool_calls: answer.toolCalls.length,
            reasoning_events: answer.reasoningEvents,
          });
        }
        const turn = answer;

        // Последняя проверка барьера — перед самой доставкой. Между
        // концом генерации и отправкой успевают выполниться связи и
        // отметка агента; отмена, пришедшая в это окно, иначе не
        // остановила бы ответ.
        if (turnHandle && this.turns && await this.turns.isCancelled(turnHandle)) {
          await this.moveTurn(turnHandle, "cancelling", { detail: { reason: "cancelled" } });
          await this.moveTurn(turnHandle, "cancelled");
          live.current?.stop();
          live.current = null;
          return { status: "ignored" };
        }

        const reply = turn.reply.trim() || t(language, "emptyReply");
        const wantsText = responseMode === "text" || responseMode === "both";
        const wantsVoice = responseMode === "voice" || responseMode === "both";

        // Синтез начинается сразу, как только текст готов, и идёт
        // параллельно доставке. Текст его больше не ждёт: раньше в
        // режиме «оба» он стоял в очереди за синтезом до сорока пяти
        // секунд, и весь выигрыш от потока пропадал на последнем шаге.
        const ttsStarted = performance.now();
        const speech = wantsVoice
          ? this.synthesizeVoice(reply)
            .then((audio) => {
              metrics.tts_ms = elapsed(ttsStarted);
              return audio;
            })
            .catch((error) => {
              metrics.tts_ms = elapsed(ttsStarted);
              this.logger.warn("Голосовой ответ недоступен", {
                updateId: update.updateId,
                message: error instanceof Error ? error.message : String(error),
              });
              return null;
            })
          : null;

        // Доставка меряется по самим отправкам, а не по всему участку:
        // между ними стоит ожидание синтеза, и приплюсовать его к
        // доставке значит послать оператора искать проблему в Telegram.
        let deliveryMs = 0;
        const deliveryStarted = performance.now();
        if (wantsText) {
          // Кнопки, о которых Ева попросила инструментом, готовятся здесь
          // и только здесь: токены случайны и от текста не зависят, а
          // сохраняются уже с идентификатором того сообщения, под которым
          // фактически встали, — иначе снять клавиатуру после выбора
          // будет не у чего.
          // Намерение оставил инструмент внутри хода — читаем из
          // контекста хода, а не из ответа модели: в тексте ответа его
          // нет и быть не должно.
          const intent = uiIntent;
          const buttons = intent
            ? intent.choices.map((choice: { label: string; value: string }) =>
              ({ ...choice, token: newCallbackToken() }))
            : null;
          const markup = buttons ? inlineKeyboard(buttons) : undefined;

          // Растущее сообщение доводится до итогового текста: тот же
          // `message_id`, второго ответа в чате не появляется. Если
          // показывать было нечего — модель ответила одним куском или
          // Telegram не принял показ, — ответ уходит обычной отправкой.
          const finished = stream
            ? await stream.finish(reply, markup)
            : { delivered: false, messageId: null, keyboardMessageId: null };
          let keyboardMessageId = finished.keyboardMessageId;
          if (!finished.delivered) {
            const sent = await this.telegram.sendMessage(
              update.chatId, reply, markup === undefined ? {} : { reply_markup: markup },
            );
            keyboardMessageId = markup === undefined
              ? null
              : telegramMessageIdOf(sent[sent.length - 1]);
          }
          if (buttons && intent) {
            await this.db.issueCallbackTokens({
              userId: context.userId,
              chatId: update.chatId,
              conversationId,
              messageId: keyboardMessageId,
              oneShot: intent.oneShot,
              ttlSeconds: CALLBACK_TOKEN_TTL_SECONDS,
              choices: buttons,
            });
          }
          live.current = null;
          deliveryMs += elapsed(deliveryStarted);
        }
        if (speech) {
          // Голос догоняет текст. В голосовом режиме ждать по-прежнему
          // приходится: без звука там ответа нет вовсе.
          const audio = wantsText
            ? await speech
            : (await withDeadline(speech, VOICE_SYNC_BUDGET_MS)) ?? await speech;
          const voiceStarted = performance.now();
          if (audio) {
            await this.telegram.sendVoice(update.chatId, audio);
            await this.touchVoiceUsage(context.userId);
          } else if (!wantsText) {
            // Голосовой режим без голоса — это молчание. Текст здесь не
            // дублирует отправленное, а заменяет несостоявшийся звук.
            await this.telegram.sendMessage(update.chatId, reply);
          }
          deliveryMs += elapsed(voiceStarted);
        }
        metrics.telegram_delivery_ms = deliveryMs;

        await this.linkTurn(turnHandle, {
          outboxId: this.telegram.getDeliveryOutboxId(),
        });
        await this.moveTurn(turnHandle, "outbox_committed");
        await this.moveTurn(turnHandle, "delivering");
        await this.moveTurn(turnHandle, "delivered");

        await this.db.incrementUsage(update.telegramId, "messages");
        await this.linkTurn(turnHandle, {
          quotaMetric: "messages",
          quotaCharged: true,
        });
        await this.moveTurn(turnHandle, "completed");
        return { status: "completed", usageCharged: true };
          },
        );
        },
        // Кто держит слот: ход этого человека, с этим `run_id`.
        // `run_id` показывается только у записанного хода: при
        // выключенном EVA_TURN_LIFECYCLE идентификатор существует, но не
        // резолвится ни во что, и оператор искал бы несуществующую
        // строку. Conversation становится известна позже, уже под
        // блокировкой, — врать про неё хуже, чем не знать.
        { runId: turnHandle?.recorded ? turnHandle.runId : null },
        ),
      );
      metrics.db_query_count = measured.queryCount;
      return measured.result;
    } catch (error) {
      // Ход оборвался. В записи остаётся безопасный код, а не текст
      // ошибки: сообщение провайдера может содержать что угодно.
      await this.moveTurn(turnHandle, "failed_retryable", {
        errorCode: error instanceof Error ? error.name : "unknown_error",
      });
      throw error;
    } finally {
      live.current?.stop();
      typing.stop?.();
      const delivery = this.telegram.getDeliveryMetrics();
      metrics.outbox_insert_ms = delivery.outboxInsertMs;
      metrics.telegram_send_ms = delivery.telegramSendMs;
      metrics.total_turn_ms = elapsed(started);
      this.logger.info("Telegram turn обработан", {
        update_id: update.updateId,
        telegram_id: update.telegramId,
        aggregated_messages: earlier.length + 1,
        ...metrics,
      });
    }
  }

  /**
   * Прервать ход по просьбе человека.
   *
   * Мимо очереди и мимо агента: ни модель, ни conversation здесь не
   * нужны, нужен только барьер отмены. Ход, который его увидит,
   * закончится сам и ничего не доставит.
   */
  private async stopRunningTurn(update: NormalizedUpdate): Promise<InboxResult> {
    return await this.db.withUserScope(
      { telegramId: update.telegramId, label: "telegram.stop" },
      async (): Promise<InboxResult> => {
        const from = update.message.from!;
        const user = await this.db.upsertUser({
          telegramId: update.telegramId,
          username: from.username ?? null,
          firstName: from.first_name ?? null,
          lastName: from.last_name ?? null,
          languageCode: from.language_code ?? null,
        });
        this.db.bindScopeUserId(user.id);
        const language = preferredResponseLanguage(user);
        const cancelled = this.turns
          ? await this.turns.cancelActiveForUser(update.telegramId, "user_stop")
          : 0;
        await this.telegram.sendMessage(
          update.chatId,
          t(language, cancelled > 0 ? "stopped" : "nothingToStop"),
        );
        this.logger.info("Ход прерван по просьбе человека", {
          telegram_id: update.telegramId,
          cancelled,
        });
        return { status: "completed" };
      },
    );
  }

  private async ensureUserAndAgent(
    update: NormalizedUpdate,
  ): Promise<{ user: UserRow; link: AgentLinkRow }> {
    const from = update.message.from!;
    const user = await this.db.upsertUser({
      telegramId: update.telegramId,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
    });
    // Область хода открыта по проверенному Telegram-идентификатору;
    // внутренний `users.id` появляется здесь, и до этого момента данные
    // пользователя ей недоступны.
    this.db.bindScopeUserId(user.id);
    let link = await this.db.getAgentLink(update.telegramId);
    if (!link) {
      let agentId = await this.letta.findAgentByTelegramId(update.telegramId);
      if (!agentId) {
        const displayName =
          [from.first_name, from.last_name].filter(Boolean).join(" ") ||
          from.username ||
          String(from.id);
        agentId = await this.letta.createAgent({
          telegramId: update.telegramId,
          displayName,
        });
      }
      const conversationId = await this.letta.createConversation(agentId);
      link = await this.db.saveAgentLink({
        userId: user.id,
        agentId,
        conversationId,
        agentName: `eva-${update.telegramId}`,
        model: this.config.model || null,
      });
      await this.db.setUserState(user.id, "active");
      return { user: { ...user, state: "active" }, link };
    }
    if (!link.conversation_id) {
      const conversationId = await this.letta.createConversation(link.agent_id);
      await this.db.setConversation(link.agent_id, conversationId, user.id);
      link = { ...link, conversation_id: conversationId };
    }
    return { user, link };
  }

  private async handleCommand(
    update: NormalizedUpdate,
    user: UserRow,
    language: SupportedLanguage,
  ): Promise<void> {
    switch (update.command) {
      case "/start": {
        const firstStart = user.state === "onboarding";
        await this.db.setUserState(user.id, "active");
        await this.telegram.sendMessage(
          update.chatId,
          t(language, firstStart ? "startFirst" : "start"),
        );
        if (firstStart) await this.profile.markAsked(user.id, "preferred_name");
        break;
      }
      case "/help":
        await this.telegram.sendMessage(
          update.chatId,
          t(language, "help"),
        );
        break;
      case "/balance": {
        const quotas = await this.db.getQuotaStatus(update.telegramId);
        const lines = quotas.map((item) => {
          const row = item as Record<string, unknown>;
          const remaining = row.remaining === null
            ? t(language, "unlimited")
            : t(language, "remaining", { value: String(row.remaining) });
          return `${quotaLabel(String(row.metric), language)}: ${remaining}`;
        });
        await this.telegram.sendMessage(
          update.chatId,
          lines.length
            ? `${t(language, "limitsTitle")}\n${lines.join("\n")}`
            : t(language, "limitsMissing"),
        );
        break;
      }
      case "/subscription": {
        const buttons = Object.entries(this.config.lavaPlans)
          .filter(([, plan]) => plan.paymentUrl)
          .map(([, plan]) => [{
            text: `${plan.plan} — ${(plan.amountMinor / 100).toFixed(0)} ${plan.currency}`,
            url: plan.paymentUrl,
          }]);
        await this.telegram.sendMessage(
          update.chatId,
          buttons.length
            ? t(language, "chooseSubscription")
            : t(language, "subscriptionUnavailable"),
          buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {},
        );
        break;
      }
      case "/stop":
        // Сюда команда доходит, только если ход уже начался мимо раннего
        // пути: останавливать в этот момент нечего — этот ход и есть
        // текущий.
        await this.telegram.sendMessage(update.chatId, t(language, "nothingToStop"));
        break;
      case "/privacy":
        await this.telegram.sendMessage(
          update.chatId,
          t(language, "privacy"),
        );
        break;
      default:
        await this.telegram.sendMessage(update.chatId, t(language, "unknownCommand"));
    }
  }

  /** media-service rejects unauthenticated callers when a token is set. */
  private mediaHeaders(): Record<string, string> {
    return this.config.mediaServiceToken
      ? { "x-media-key": this.config.mediaServiceToken }
      : {};
  }

  /**
   * Распознавание через реестр STT-провайдеров.
   *
   * Маршрут, основной провайдер и резерв выбирает media-service: только
   * он видит сам файл, и только он может не заплатить за одно аудио
   * дважды. Здесь остаётся то, что относится к разговору, — квоты,
   * текст пользователю и запись расхода.
   *
   * Пользователю не показывается ни код ошибки, ни сообщение
   * провайдера: «Deepgram вернул HTTP 429» ему нечего с этим делать.
   * Полная причина уходит в лог и в панель администратора.
   */
  private async transcribeVoice(
    useCase: "telegram_voice" | "webapp_voice_message",
    fileId: string,
    idempotencyKey: string | null,
    language: string,
  ): Promise<{
    text: string;
    durationSeconds: number;
    durationMinutes: number;
    provider: string;
    model: string;
    durationMs: number;
    latencyMs: number;
    usedFallback: boolean;
    fromCache: boolean;
  }> {
    let response: Response;
    try {
      response = await fetch(
        `${this.config.mediaServiceUrl.replace(/\/+$/, "")}/stt/transcribe`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.mediaHeaders() },
          body: JSON.stringify({
            use_case: useCase,
            file_id: fileId,
            language,
            idempotency_key: idempotencyKey,
          }),
          signal: AbortSignal.timeout(5 * 60_000),
        },
      );
    } catch (error) {
      this.logger.warn("media-service недоступен для распознавания", {
        use_case: useCase,
        code: error instanceof Error ? error.name : "unknown_error",
      });
      throw new VoiceTranscriptionError("media-service недоступен");
    }

    const body = await response.json().catch(() => ({})) as {
      text?: string;
      language?: string;
      provider?: string;
      model?: string;
      duration_seconds?: number;
      duration_minutes?: number;
      latency_ms?: number;
      used_fallback?: boolean;
      from_cache?: boolean;
      attempts?: Array<Record<string, unknown>>;
      error?: { code?: string; message?: string };
    };

    if (!response.ok) {
      // Техническая причина остаётся здесь и в панели, к пользователю
      // уходит один и тот же понятный текст.
      this.logger.warn("распознавание не удалось", {
        use_case: useCase,
        error_code: body.error?.code ?? `http_${response.status}`,
        message: body.error?.message?.slice(0, 200),
      });
      throw new VoiceTranscriptionError(body.error?.message ?? `HTTP ${response.status}`);
    }
    if (!body.text?.trim()) {
      // Пустая расшифровка — это не сбой тракта, а тишина в записи.
      // Но продолжать разговор с пустым сообщением бессмысленно.
      this.logger.info("распознавание вернуло пустой текст", { use_case: useCase });
      throw new VoiceTranscriptionError("пустая расшифровка");
    }

    if (body.used_fallback) {
      this.logger.warn("распознавание ушло на резервного провайдера", {
        use_case: useCase,
        provider: body.provider,
      });
    }

    const durationSeconds = Math.max(0, Number(body.duration_seconds) || 0);
    const attempts = normalizeSttAttempts(body.attempts, {
      provider: body.provider ?? "unknown",
      model: body.model ?? "unknown",
      latencyMs: body.latency_ms ?? 0,
    });
    if (!body.from_cache) {
      await this.db.recordSttUsage({
        useCase,
        attempts,
        audioSeconds: durationSeconds,
        idempotencyKey,
      });
    }

    return {
      text: body.text.trim(),
      durationSeconds,
      durationMinutes: body.duration_minutes ?? 0,
      provider: body.provider ?? "unknown",
      model: body.model ?? "unknown",
      durationMs: Math.round(durationSeconds * 1000),
      latencyMs: body.latency_ms ?? 0,
      usedFallback: body.used_fallback === true,
      fromCache: body.from_cache === true,
    };
  }

  /**
   * Что человек прислал этим сообщением.
   *
   * Три вещи разделены намеренно: реплика человека (текст или подпись),
   * изображения — они уходят модели изображениями, а не пересказом, — и
   * содержимое файлов, которое остаётся недоверенными данными.
   */
  private async promptFromMessage(
    update: NormalizedUpdate,
  ): Promise<{ text: string; images: AttachmentImage[]; attachments: string[] }> {
    const message = update.message;
    const caption = (message.caption ?? message.text ?? "").trim();
    const only = (text: string) => ({ text, images: [], attachments: [] });

    if (update.kind === "text") return only(caption);

    if (update.kind === "voice") {
      // Голосовое, аудио и звук, присланный файлом, идут одним и тем же
      // путём распознавания: разными их делает только способ отправки.
      const file = audioFileOf(message);
      if (!file) throw new Error("Голосовой файл отсутствует");
      const transcription = await this.transcribeVoice(
        "telegram_voice",
        file.file_id,
        // file_unique_id не меняется при повторной доставке апдейта, в
        // отличие от file_id. Telegram повторяет доставку при таймауте
        // вебхука, и без этого ключа одно голосовое оплачивалось бы
        // дважды.
        file.file_unique_id ?? null,
        message.from?.language_code ?? "ru",
      );
      if (!transcription.fromCache && transcription.durationMinutes) {
        await this.db.incrementUsage(
          update.telegramId,
          "voice_minutes",
          Math.max(1, Math.ceil(transcription.durationMinutes)),
        );
      }
      await this.telegram.sendPlainMessage(
        update.chatId,
        formatVoiceTranscriptEcho(transcription.text),
      );
      // Подпись к аудиофайлу — тоже слова человека, и терять её незачем.
      return only([transcription.text, caption].filter(Boolean).join("\n"));
    }

    if (update.kind === "image") {
      const file = imageFileOf(message);
      if (!file) throw new Error("Изображение отсутствует");
      const image = await this.attachments.image(file);
      // Само изображение уходит модели изображением. Отдельного описания
      // больше нет: пересказ картинки чужой моделью — это уже не то, что
      // видит Ева.
      return { text: caption, images: [image], attachments: [] };
    }

    if (update.kind === "document") {
      const document = message.document;
      if (!document) throw new Error("Документ отсутствует");
      const content = await this.attachments.document(document);
      return { text: caption, images: [], attachments: [content] };
    }

    throw new Error("Неподдерживаемый тип сообщения");
  }

  /**
   * Сообщение для Letta.
   *
   * Без изображений это обычная строка — так ход выглядел всегда. С
   * изображениями это список частей: текст и картинки рядом. Дальше их
   * несёт Letta, а роутер разворачивает в формат провайдера и уводит
   * запрос на маршрут зрения.
   */
  private messageForLetta(text: string, images: AttachmentImage[]): SendMessage {
    if (images.length === 0) return text;
    return [
      { type: "text", text },
      ...images.slice(0, MAX_IMAGES_PER_TURN).map((image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          data: image.base64,
        },
      })),
    ];
  }

  /**
   * Синтез без отправки. Разделение нужно затем, чтобы вызывающий сам
   * решал, когда отправлять звук: в режиме «голос и текст» он уходит
   * сразу за текстом, а не через секунды синтеза после него.
   */
  private async synthesizeVoice(text: string): Promise<Uint8Array> {
    const response = await fetch(`${this.config.mediaServiceUrl.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.mediaHeaders() },
      body: JSON.stringify({ text: text.slice(0, 8_000), format: "voice" }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`TTS вернул HTTP ${response.status}: ${message.slice(0, 500)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private async touchVoiceUsage(userId?: number): Promise<void> {
    if (!userId) return;
    await this.db.query(
      "UPDATE user_preferences SET updated_at = now() WHERE user_id = $1",
      [userId],
    );
  }
}

export function normalizeUpdate(update: TelegramUpdate): NormalizedUpdate | null {
  const message = update.message ?? update.edited_message;
  const from = message?.from;
  if (!message || !from || from.is_bot) return null;
  const commandMatch = message.text?.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  const command = commandMatch?.[1] ? `/${commandMatch[1].toLowerCase()}` : null;
  // Вид сообщения определяется одним разбором: снимок экрана, присланный
  // файлом, остаётся изображением, а голосовая запись файлом — голосом.
  const kind = telegramMediaKind(message);
  return {
    updateId: update.update_id,
    message,
    telegramId: from.id,
    chatId: message.chat.id,
    messageId: message.message_id,
    kind,
    command,
    replyToMessageId: Number.isSafeInteger(message.reply_to_message?.message_id)
      ? message.reply_to_message!.message_id
      : null,
  };
}

/** Hermes-compatible transcript echo shown before the agent's answer. */
export function formatVoiceTranscriptEcho(text: string): string {
  return `🎙️ "${text.trim()}"`;
}

function normalizeSttAttempts(
  value: Array<Record<string, unknown>> | undefined,
  fallback: { provider: string; model: string; latencyMs: number },
): SttUsageAttempt[] {
  const attempts = (value ?? []).map((attempt) => ({
    configId: typeof attempt.config_id === "string" ? attempt.config_id : null,
    provider: typeof attempt.provider === "string" ? attempt.provider : fallback.provider,
    model: typeof attempt.model === "string" ? attempt.model : fallback.model,
    ok: attempt.ok === true,
    latencyMs: Math.max(0, Math.round(Number(attempt.latency_ms) || 0)),
    isFallback: attempt.is_fallback === true,
    errorCode: typeof attempt.error_code === "string" ? attempt.error_code : null,
  }));
  return attempts.length > 0
    ? attempts
    : [{
        configId: null,
        provider: fallback.provider,
        model: fallback.model,
        ok: true,
        latencyMs: Math.max(0, Math.round(fallback.latencyMs)),
        isFallback: false,
        errorCode: null,
      }];
}

function quotaLabel(metric: string, language: SupportedLanguage): string {
  return (language === "en"
    ? {
        messages: "Messages",
        voice_minutes: "Voice minutes",
        web_search: "Search",
        tests: "Tests",
      }
    : {
        messages: "Сообщения",
        voice_minutes: "Голосовые минуты",
        web_search: "Поиск",
        tests: "Тесты",
      })[metric] ?? metric;
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 10) / 10;
}
