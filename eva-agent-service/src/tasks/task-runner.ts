/**
 * Выполнение наступившей задачи.
 *
 * Отделено от интервалов планировщика намеренно: выбрать наступившие
 * строки и выполнить одну задачу — разная работа с разной ценой ошибки.
 * Здесь живёт всё, что делается с задачей, у которой пришёл срок: ход
 * агента, доставка, учёт попыток и сдвиг расписания.
 */

import { randomUUID } from "node:crypto";

import type { ConversationPurposeService } from "../conversations/purpose-service.js";
import type { Database } from "../db.js";
import { preferredResponseLanguage, t } from "../i18n/index.js";
import type { LettaService } from "../letta.js";
import type { Logger } from "../logger.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";
import type { TelegramClient } from "../telegram.js";
import { nextCronDate } from "../time/cron.js";
import type { UserTurnLock } from "../turns/user-turn-lock.js";
import { TaskEventService } from "./task-event-service.js";
import {
  ACTION_DAILY_LIMIT,
  DAILY_LIMIT_DELAY_MS,
  retryAfterFailure,
  scheduledInstruction,
  taskKindOf,
  type TaskKind,
} from "./task-run.js";

export interface DueTask {
  id: string;
  user_id: string;
  telegram_id: string;
  chat_id: string;
  kind: string;
  title: string;
  description: string | null;
  priority: number;
  attempts: number;
  due_at: Date | null;
  remind_at: Date | null;
  related_goal: string | null;
  previous_runs: number;
  last_task_action: string | null;
  cron_expression: string | null;
  repeat_enabled: boolean;
  timezone: string;
  agent_id: string;
  conversation_id: string;
  scheduled_at: Date;
  language_mode: string;
  preferred_language: string | null;
  last_message_language: string | null;
  language_code: string | null;
}

export class ScheduledTaskRunner {
  constructor(
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly queue: UserTurnLock,
    private readonly telegram: TelegramClient,
    private readonly runtimeContext: RuntimeContextBuilder,
    private readonly purposes: ConversationPurposeService,
    private readonly taskEvents: TaskEventService,
    private readonly logger: Logger,
  ) {}

  /**
   * Наступивший срок задачи.
   *
   * Развилка одна, и она вся разница: `reminder` возвращает работу
   * человеку — Ева сочиняет сообщение и отправляет его; `action` человек
   * уже поручил Еве, и тогда работу делает она сама, а сообщением
   * становится результат.
   *
   * Действие идёт в conversation назначения `task_action`: у планировщика
   * инструменты запрещены целиком, и просьба «найди новости» упиралась бы
   * там в первый же вызов. Какими инструментами выполнять задачу, решает
   * Letta — Evaself только называет задачу и рамку (инварианты 3 и 17).
   */
  async execute(task: DueTask): Promise<void> {
    const correlationId = randomUUID();
    const kind = taskKindOf(task.kind);
    const doneEvent = kind === "action" ? "action_done" : "reminder_sent";
    try {
      const delivered = await this.db.query(
        `SELECT 1 FROM task_events
          WHERE user_id=$3 AND task_id=$1
            AND event_type=$4 AND scheduled_at=$2
          LIMIT 1`,
        [task.id, task.scheduled_at, task.user_id, doneEvent],
      );
      if ((delivered.rowCount ?? 0) > 0) {
        await this.rescheduleTask(task);
        return;
      }
      if (kind === "action" && await this.postponedByDailyLimit(task)) return;

      const conversation = await this.purposes.ensure({
        userId: Number(task.user_id),
        agentId: task.agent_id,
        purpose: kind === "action" ? "task_action" : "scheduler",
        parentConversationId: task.conversation_id,
      });
      const userMessage = scheduledInstruction({
        taskId: task.id,
        kind,
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueAt: task.due_at,
        remindAt: task.remind_at,
        timezone: task.timezone,
        relatedGoal: task.related_goal,
        previousRuns: Number(task.previous_runs) || 0,
        lastTaskAction: task.last_task_action,
      });
      const context = await this.runtimeContext.build({
        userId: Number(task.user_id),
        conversationId: conversation.conversationId,
        userMessage,
        detectLanguage: false,
      });
      const prompt = this.runtimeContext.wrapUserMessage(context, userMessage, {
        internalOperationType: kind === "action" ? "task_action" : "task_reminder",
        correlationId,
      });
      const turn = await this.queue.run(
        Number(task.telegram_id),
        () => this.letta.runTurn(conversation.conversationId, prompt),
        { userId: Number(task.user_id), conversationId: conversation.conversationId },
      );
      const generatedText = turn.reply.trim();
      // Пустой ответ на действие — это отказ, а не «нечего сказать»:
      // человек ждёт результат, и промолчать здесь значит сделать вид,
      // что задачи не было. Такой заход уходит в общий путь неудачи и
      // повторяется, а не закрывается тихо.
      if (kind === "action" && !generatedText) {
        throw new Error("ход завершился без результата");
      }
      if (kind === "reminder") {
        await this.taskEvents.record({
          userId: Number(task.user_id), taskId: task.id,
          eventType: "reminder_generated", scheduledAt: task.scheduled_at,
          generatedAt: new Date(), generatedText,
          conversationId: conversation.conversationId, llmRequestId: correlationId,
        });
      }
      let telegramMessageId: number | null = null;
      if (generatedText) {
        // Напоминание пропускает вперёд ответ на живой вопрос: человек,
        // который сейчас разговаривает, ждёт именно ответ.
        const sent = await this.telegram.withPriority(
          "reminder",
          async () => await this.telegram.sendMessage(Number(task.chat_id), generatedText),
        );
        telegramMessageId = lastTelegramMessageId(Array.isArray(sent) ? sent : []);
      }
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: doneEvent, scheduledAt: task.scheduled_at,
        generatedAt: new Date(), sentAt: new Date(), generatedText,
        deliveryStatus: generatedText ? "sent" : "skipped_empty",
        telegramChatId: task.chat_id, telegramMessageId,
        conversationId: conversation.conversationId, llmRequestId: correlationId,
      });
      // Разовое действие закрывается само: работа сделана Евой, и ждать
      // от человека отметки «выполнено» не за что. Напоминание остаётся
      // открытым — выполнил его человек или нет, знает только он.
      await this.rescheduleTask(task, { complete: kind === "action" });
      await this.db.markAgentUsed(task.agent_id, Number(task.user_id));
    } catch (error) {
      await this.failTask(task, kind, error, correlationId);
    }
  }

  /**
   * Потолок автономных действий на сутки.
   *
   * Заход не отменяется, а откладывается: повторяющаяся задача, упершаяся
   * в потолок, должна выполниться, когда сутки сдвинутся, а не пропасть
   * молча. Событие пишется с кодом `daily_limit` и в счёт самих суток не
   * идёт — иначе отложенные заходы съедали бы потолок, которого не
   * тратили.
   */
  private async postponedByDailyLimit(task: DueTask): Promise<boolean> {
    const used = await this.taskEvents.actionsLastDay(Number(task.user_id));
    if (used < ACTION_DAILY_LIMIT) return false;
    await this.taskEvents.record({
      userId: Number(task.user_id), taskId: task.id,
      eventType: "action_failed", errorCode: "daily_limit",
      metadata: { used, limit: ACTION_DAILY_LIMIT },
    });
    const postponed = new Date(Date.now() + DAILY_LIMIT_DELAY_MS);
    await this.db.query(
      `
        -- tenant: by task_id — задача принадлежит одному пользователю, проверка владения выше по стеку
        UPDATE tasks SET next_run_at = $2, locked_at = NULL
        WHERE id = $1 AND user_id = $3`,
      [task.id, postponed.toISOString(), task.user_id],
    );
    this.logger.warn("Суточный потолок действий исчерпан", {
      taskId: task.id, used, limit: ACTION_DAILY_LIMIT,
    });
    return true;
  }

  /**
   * Срок отработал: сдвинуть расписание.
   *
   * Один и тот же переход нужен трём исходам — удаче, повтору уже
   * доставленного срока и исчерпанным попыткам, — и разойтись им нельзя:
   * забытый `last_run_at` возвращает задачу планировщику через тридцать
   * секунд, и так до бесконечности.
   */
  private async rescheduleTask(
    task: DueTask,
    options: { complete?: boolean; error?: string } = {},
  ): Promise<void> {
    const next = task.repeat_enabled && task.cron_expression
      ? nextCronDate(task.cron_expression, task.timezone, new Date())
      : null;
    const complete = options.complete === true && next === null;
    await this.db.query(
      `
        -- tenant: by task_id — задача уже принадлежит одному пользователю, проверка владения выше по стеку
        UPDATE tasks SET
         last_run_at = now(),
         next_run_at = $2,
         remind_at = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE remind_at END,
         status = CASE WHEN $4::boolean THEN 'done' ELSE status END,
         completed_at = CASE WHEN $4::boolean THEN now() ELSE completed_at END,
         attempts = 0,
         locked_at = NULL,
         last_error = $5
       WHERE id = $1 AND user_id = $3`,
      [task.id, next?.toISOString() ?? null, task.user_id, complete, options.error ?? null],
    );
  }

  /**
   * Заход не удался.
   *
   * Попытки считаются и заканчиваются. Раньше неудача только снимала
   * блокировку строки, не двигая срок, — и планировщик забирал ту же
   * задачу каждые тридцать секунд до скончания века; для действия это
   * ещё и счёт провайдера.
   *
   * Исчерпав попытки, планировщик не молчит: человек услышит то, ради
   * чего задача заводилась, — напоминание своим текстом или честное «не
   * получилось». Повторяющаяся задача при этом живёт дальше: сорванный
   * заход не отменяет расписание.
   */
  private async failTask(
    task: DueTask,
    kind: TaskKind,
    error: unknown,
    correlationId: string,
  ): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    const attempts = (Number(task.attempts) || 0) + 1;
    const retryAt = retryAfterFailure(attempts, new Date());
    await this.taskEvents.record({
      userId: Number(task.user_id), taskId: task.id,
      eventType: kind === "action" ? "action_failed" : "delivery_failed",
      scheduledAt: task.scheduled_at,
      deliveryStatus: "failed", telegramChatId: task.chat_id,
      conversationId: task.conversation_id, llmRequestId: correlationId,
      errorCode: error instanceof Error ? error.name : "unknown_error",
      metadata: { message: message.slice(0, 500), attempts },
    }).catch(() => undefined);
    if (retryAt) {
      await this.db.query(
        `
          -- tenant: by task_id — задача принадлежит одному пользователю, проверка владения выше по стеку
          UPDATE tasks SET attempts = $4, next_run_at = $5, locked_at = NULL, last_error = $2
          WHERE id = $1 AND user_id = $3`,
        [task.id, message, task.user_id, attempts, retryAt.toISOString()],
      );
    } else {
      await this.notifyFailure(task, kind);
      await this.rescheduleTask(task, { error: message });
    }
    this.logger.warn("Задача не выполнена", {
      taskId: task.id, kind, attempts, willRetry: retryAt !== null, message,
    });
  }

  /**
   * Последнее слово планировщика, когда ход агента так и не состоялся.
   *
   * Текст детерминированный и короткий: сочинять его некому — именно
   * генерация и не удалась. Для напоминания это само напоминание: оно
   * лучше молчания, ради него задача и заводилась.
   */
  private async notifyFailure(task: DueTask, kind: TaskKind): Promise<void> {
    const language = preferredResponseLanguage({
      language_mode: task.language_mode,
      preferred_language: task.preferred_language,
      last_message_language: task.last_message_language,
      language_code: task.language_code,
    });
    const text = t(
      language,
      kind === "action" ? "scheduledActionFailed" : "scheduledReminderFallback",
      { title: task.title.slice(0, 200) },
    );
    try {
      const sent = await this.telegram.withPriority(
        "reminder",
        async () => await this.telegram.sendMessage(Number(task.chat_id), text),
      );
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: kind === "action" ? "action_failed" : "reminder_sent",
        scheduledAt: task.scheduled_at, sentAt: new Date(), generatedText: text,
        deliveryStatus: "fallback", telegramChatId: task.chat_id,
        telegramMessageId: lastTelegramMessageId(Array.isArray(sent) ? sent : []),
      });
    } catch (error) {
      // Доставка последнего слова — не повод потерять сам разбор отказа:
      // задача уже закрывается, и второй раз сюда никто не вернётся.
      this.logger.warn("Сообщение о сорванной задаче не доставлено", {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function lastTelegramMessageId(results: unknown[]): number | null {
  for (const value of [...results].reverse()) {
    if (!value || typeof value !== "object") continue;
    const id = Number((value as { message_id?: unknown }).message_id);
    if (Number.isSafeInteger(id)) return id;
    const nested = (value as { result?: unknown }).result;
    if (nested && typeof nested === "object") {
      const nestedId = Number((nested as { message_id?: unknown }).message_id);
      if (Number.isSafeInteger(nestedId)) return nestedId;
    }
  }
  return null;
}
