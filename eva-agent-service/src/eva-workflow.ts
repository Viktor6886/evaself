import type { Config } from "./config.js";
import { type CrisisMonitor, safetyDirective } from "./crisis.js";
import type { AgentLinkRow, Database, SttUsageAttempt, UserRow } from "./db.js";
import type { InboxResult } from "./delivery/inbox.js";
import { preferredResponseLanguage, t } from "./i18n/index.js";
import type { SupportedLanguage } from "./i18n/language-resolver.js";
import type { LettaService } from "./letta.js";
import type { LlmManager } from "./llm.js";
import type { Logger } from "./logger.js";
import type { GraphContextService } from "./memory/graph-context.js";
import type { ConversationHighlightService } from "./memory/conversation-highlights.js";
import type { UserProfileService } from "./profile/profile-service.js";
import type { UserTurnLock } from "./turns/user-turn-lock.js";
import type { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import { TaskEventService } from "./tasks/task-event-service.js";
import {
  TURN_FLOW_VERSION,
  type TurnHandle,
  type TurnLifecycle,
  type TurnLinks,
} from "./turns/turn-lifecycle.js";
import {
  type TelegramMessage,
  type TelegramMessageDraft,
  type TelegramUpdate,
  TelegramClient,
} from "./telegram.js";

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
 * Кто ведёт ход. Аренда сама по себе ничего не сериализует — она
 * отвечает на вопрос «чей это ход был», когда процесс перезапустился и
 * незавершённые записи надо разобрать.
 */
const LEASE_OWNER = `eva-agent-service:${process.pid}`;

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
    private readonly graphContext?: GraphContextService,
    private readonly highlights?: ConversationHighlightService,
    /**
     * Наблюдатель хода. Необязателен намеренно: без него путь обработки
     * сообщения тот же самый, что и до этого шага.
     */
    private readonly turns?: TurnLifecycle,
  ) {
    this.taskEvents = new TaskEventService(db);
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
   * Объединённый ход: несколько быстрых сообщений одного человека
   * отвечаются одним ходом.
   *
   * Отвечаем на последнее сообщение — оно и есть та реплика, которую
   * человек дописывал; предыдущие входят в тот же промпт перед ним.
   * Квота снимается один раз: ход один.
   */
  async processAggregated(updates: TelegramUpdate[]): Promise<InboxResult> {
    const normalized = updates
      .map((update) => normalizeUpdate(update))
      .filter((item): item is NormalizedUpdate => item !== null);
    if (normalized.length === 0) return { status: "ignored" };
    const primary = normalized[normalized.length - 1]!;
    const earlier = normalized.slice(0, -1);
    return await this.telegram.withDeliveryContext(
      `telegram-update:${primary.updateId}`,
      async () => await this.process(primary, earlier),
    );
  }

  private async process(
    update: NormalizedUpdate,
    earlier: NormalizedUpdate[] = [],
  ): Promise<InboxResult> {
    const typing: { stop: (() => void) | null } = { stop: null };
    const messageDraft: { current: TelegramMessageDraft | null } = { current: null };
    const started = performance.now();
    const metrics = {
      runtime_context_ms: 0,
      profile_check_ms: 0,
      graph_query_ms: 0,
      letta_turn_ms: 0,
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
    if (earlier.length > 0) {
      await this.moveTurn(turnHandle, "aggregating", {
        detail: { messages: earlier.length + 1 },
      });
    }
    await this.moveTurn(turnHandle, "queued");
    try {
      const measured = await this.db.withQueryMetrics(async () =>
        await this.queue.run(update.telegramId, async (): Promise<InboxResult> => {
        if (this.turns && turnHandle) {
          // Слот пользователя получен: сколько ход его ждал и кто теперь
          // его ведёт. Аренда нужна восстановлению после перезапуска.
          await this.turns.recordWait(turnHandle, elapsed(started));
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
        if ([...earlier, update].some((part) => part.kind === "voice")) {
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
            await this.stopTurn(turnHandle, "quota_voice");
            return { status: "ignored" };
          }
        }

        let prompt: string;
        try {
          // Порядок сообщений сохраняется: человек дописывал мысль, и
          // прочитать её задом наперёд — значит прочитать другую мысль.
          const parts: string[] = [];
          for (const part of [...earlier, update]) {
            const text = (await this.promptFromMessage(part)).trim();
            if (text) parts.push(text);
          }
          prompt = parts.join("\n");
        } catch (error) {
          // Провал распознавания — не сбой Евы: разговор продолжается,
          // просто этим сообщением. Технический текст провайдера сюда
          // не попадает, он остался в логе.
          if (error instanceof VoiceTranscriptionError) {
            await this.telegram.sendMessage(update.chatId, t(language, "voiceFailed"));
            await this.stopTurn(turnHandle, "voice_transcription_failed");
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
        await this.db.recordUserMessage(user.id);
        const conversationId = link.conversation_id;
        if (!conversationId) throw new Error("У агента отсутствует активный conversation");

        await this.moveTurn(turnHandle, "context_building");
        const graph = await this.graphContext?.findRelevant(user.id, prompt);
        metrics.graph_query_ms = graph?.elapsedMs ?? 0;
        if (graph?.used) {
          this.logger.debug("Графовый контекст обработан", {
            userId: user.id,
            graph_query_ms: graph.elapsedMs,
            graph_nodes: graph.relevantMemory.length,
            graph_timeout: graph.timedOut,
          });
        }
        const context = await this.runtimeContext.build({
          userId: user.id,
          conversationId,
          userMessage: prompt,
          languageMessage:
            update.message.text?.trim() ||
            update.message.caption?.trim() ||
            (update.kind === "voice" ? prompt : ""),
          relevantMemory: graph?.relevantMemory,
        });
        metrics.runtime_context_ms = context.metrics?.runtimeContextMs ?? 0;
        metrics.profile_check_ms = context.metrics?.profileCheckMs ?? 0;
        const responseMode = context.responseMode;
        if (responseMode === "text" || responseMode === "both") {
          messageDraft.current = await this.telegram.startMessageDraft(update.chatId);
        }
        // Recorded and escalated before the turn runs, so a disclosure
        // survives even if the model's answer is slow, truncated or unhelpful.
        const signal = await this.crisis?.inspect({
          userId: user.id,
          telegramId: update.telegramId,
          text: prompt,
        });

        await this.moveTurn(turnHandle, "context_built");
        // Сообщение уходит в App Server, и до его ответа ход находится
        // в обработке модели. Обе отметки ставятся здесь: промежуточной
        // точки наблюдения один вызов SDK не даёт.
        await this.moveTurn(turnHandle, "sent_to_letta");
        await this.moveTurn(turnHandle, "letta_processing");
        const lettaStarted = performance.now();
        let answer;
        try {
          answer = await this.letta.runTurn(
            conversationId,
            this.runtimeContext.wrapUserMessage(
              context,
              signal ? `${safetyDirective(signal)}\n\n${prompt}` : prompt,
              { messageSource: update.kind, crisisLevel: signal?.severity ?? "none" },
            ),
          );
        } finally {
          metrics.letta_turn_ms = elapsed(lettaStarted);
        }
        await this.moveTurn(turnHandle, "result_received", {
          // Только счётчики: ни аргументов инструментов, ни текста.
          detail: { tool_calls: answer.toolCalls.length },
        });
        // Отдельного идентификатора сессии Agent SDK не отдаёт: сессия
        // адресуется conversation, им и связываем.
        await this.linkTurn(turnHandle, { lettaSessionId: answer.conversationId });
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
            reasoning_items: answer.reasoning.length,
          });
        }
        this.highlights?.schedule(user.id, conversationId);
        const turn = answer;

        const reply = turn.reply.trim() || t(language, "emptyReply");
        if (responseMode === "text" || responseMode === "both") {
          await this.telegram.sendProgressiveMessage(update.chatId, reply, messageDraft.current);
          messageDraft.current = null;
        }
        if (responseMode === "voice" || responseMode === "both") {
          try {
            await this.sendVoice(update.chatId, reply, context.userId);
          } catch (error) {
            this.logger.warn("Голосовой ответ недоступен, отправлен текст", {
              updateId: update.updateId,
              message: error instanceof Error ? error.message : String(error),
            });
            if (responseMode === "voice") await this.telegram.sendMessage(update.chatId, reply);
          }
        }

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
      messageDraft.current?.stop();
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
        await this.telegram.sendProgressiveMessage(
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

  private async promptFromMessage(
    update: NormalizedUpdate,
  ): Promise<string> {
    const message = update.message;
    if (update.kind === "text") return message.text?.trim() || message.caption?.trim() || "";
    if (update.kind === "voice") {
      const file = message.voice ?? message.audio;
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
      return transcription.text;
    }
    if (update.kind === "image") {
      const photo = message.photo?.at(-1);
      if (!photo) throw new Error("Изображение отсутствует");
      const downloaded = await this.telegram.downloadFile(photo.file_id);
      const mime = downloaded.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const caption = message.caption?.trim();
      const description = await this.llm.complete([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Подробно и без домыслов опиши изображение для личного AI-агента Евы. Извлеки весь видимый текст. Вопрос пользователя: ${caption || "(нет вопроса)"}`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${Buffer.from(downloaded.bytes).toString("base64")}`,
              },
            },
          ],
        },
      ]);
      return `[ИЗОБРАЖЕНИЕ ПОЛЬЗОВАТЕЛЯ]\n${description}\n\nКомментарий: ${caption || "нет"}`;
    }
    if (update.kind === "document") {
      const document = message.document;
      if (!document) throw new Error("Документ отсутствует");
      if ((document.file_size ?? 0) > 2 * 1024 * 1024) {
        throw new Error("Документ больше 2 МБ; отправьте текст или более короткий файл");
      }
      const downloaded = await this.telegram.downloadFile(document.file_id);
      const filename = document.file_name ?? downloaded.path;
      const isText = /\.(txt|md|json|csv|log|yaml|yml)$/i.test(filename) ||
        document.mime_type?.startsWith("text/");
      if (!isText) {
        throw new Error("Пока поддерживаются текстовые документы: txt, md, json, csv, yaml");
      }
      const contents = new TextDecoder("utf-8", { fatal: false }).decode(downloaded.bytes);
      return `[ДОКУМЕНТ ${filename}]\n${contents.slice(0, 100_000)}\n\nКомментарий: ${message.caption ?? "нет"}`;
    }
    throw new Error("Неподдерживаемый тип сообщения");
  }

  private async sendVoice(chatId: number, text: string, userId?: number): Promise<void> {
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
    await this.telegram.sendVoice(chatId, new Uint8Array(await response.arrayBuffer()));
    if (userId) {
      await this.db.query(
        "UPDATE user_preferences SET updated_at = now() WHERE user_id = $1",
        [userId],
      );
    }
  }
}

export function normalizeUpdate(update: TelegramUpdate): NormalizedUpdate | null {
  const message = update.message ?? update.edited_message;
  const from = message?.from;
  if (!message || !from || from.is_bot) return null;
  const commandMatch = message.text?.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  const command = commandMatch?.[1] ? `/${commandMatch[1].toLowerCase()}` : null;
  const kind = message.voice || message.audio
    ? "voice"
    : message.photo?.length
      ? "image"
      : message.document
        ? "document"
        : message.text || message.caption
          ? "text"
          : "unsupported";
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
