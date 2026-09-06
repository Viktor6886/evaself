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
import { EvaError } from "../errors.js";
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
  approvalRetryAt,
  retryAfterFailure,
  scheduledInstruction,
  taskKindOf,
  type TaskKind,
} from "./task-run.js";

/**
 * Что планировщику нужно знать о подтверждениях.
 *
 * Интерфейс узкий намеренно: планировщик не выдаёт прав и не принимает
 * решений за человека — он только спрашивает, чем кончился вопрос,
 * заданный внутри хода, которого он не видел.
 */
/**
 * Через сколько сказать человеку, что работа идёт.
 *
 * Полторы минуты — граница между «сейчас придёт» и «кажется, ничего не
 * будет». Быстрая задача до неё не доживает и лишнего сообщения не
 * порождает.
 */
const LONG_WORK_NOTICE_MS = 90_000;

/**
 * Через сколько вернуться к задаче, уступившей живому сообщению.
 *
 * Две минуты: столько живой ход занимает в худшем случае. Человек,
 * который пишет непрерывно час, будет откладывать задачу час — и это
 * верно: его разговор важнее её срока.
 */
const YIELD_DELAY_MS = 2 * 60_000;

export interface ApprovalOutcomeSource {
  lastUnattendedApproval(
    userId: number,
    conversationId: string,
    since: Date,
  ): Promise<{ status: string; toolName: string; description: string } | null>;
}

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
    /**
     * Подтверждения действий. `null` — контур выключен, и тогда
     * фоновому ходу нечего ждать: он либо выполнил, либо нет.
     */
    private readonly approvals: ApprovalOutcomeSource | null = null,
    /**
     * Потолок хода выполнения задачи. Отдельный от интерактивного:
     * цепочка «найди — прочитай — напиши — опубликуй» в четыре минуты
     * не укладывается, а обрыв по таймауту человек читает как «не
     * получилось». `undefined` — общий потолок.
     */
    private readonly actionTurnTimeoutMs?: number,
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
    // Ветка служебного хода закрывается, чем бы заход ни кончился.
    //
    // Она была вечной: одна на человека, и в ней копились все задания
    // подряд вместе с ответами на них. На новом задании модель видела
    // перед собой не задачу, а накопленное состояние трекера — и
    // отвечала человеку сводкой вместо погоды. Прошлые ответы в той же
    // ветке перебивают любую формулировку инструкции: их много, и они
    // выглядят как образец.
    //
    // `finally`, а не «после успеха»: неудачный заход оставляет после
    // себя самый мусор, и повтору он мешает больше всего.
    const purpose = kind === "action" ? "task_action" : "scheduler";
    try {
      await this.runOccurrence(task, kind, correlationId);
    } finally {
      // Уборка не может отменить сделанную работу: результат уже у
      // человека или уже записан, а незакрытая ветка — это ровно то,
      // что было до сих пор, а не новая поломка. Сам сервис назначений
      // ошибки тоже глушит, но полагаться на чужую вежливость в
      // `finally` нельзя: отсюда исключение перекрыло бы исход захода.
      await this.purposes.close(Number(task.user_id), task.agent_id, purpose)
        .catch(() => undefined);
    }
  }

  private async runOccurrence(
    task: DueTask,
    kind: TaskKind,
    correlationId: string,
  ): Promise<void> {
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
      // Момент запуска нужен разбору подтверждений: вопросы, заданные
      // прошлыми заходами, уже закрыты, и принимать их за свои значило
      // бы ждать ответа, который давно получен.
      const turnStartedAt = new Date();
      // Отметка о долгой работе заводится ВНУТРИ блокировки, а не до
      // неё: снаружи её отсчёт включал бы ожидание очереди, и человек
      // получал бы «взялась» за работу, которая ещё не началась.
      //
      // И только на первой попытке. Повтор — это та же работа, а не
      // новая: человек получал «Взялась за „Найти погоду“» второй и
      // третий раз подряд и справедливо считал, что Ева топчется на
      // месте.
      const firstAttempt = (Number(task.attempts) || 0) === 0;
      let progress: NodeJS.Timeout | null = null;
      const turn = await this.queue.run(
        Number(task.telegram_id),
        () => {
          if (kind === "action" && firstAttempt) progress = this.announceLongWork(task);
          return this.letta.runTurn(conversation.conversationId, prompt, {
            timeoutMs: kind === "action" ? this.actionTurnTimeoutMs : undefined,
            // Живое сообщение важнее фоновой работы. Ход выполнения
            // задачи держит блокировку пользователя, и без уступки
            // человек, написавший в эту минуту, ждал бы её до конца —
            // до десяти минут молчания в ответ на «привет».
            //
            // Барьер спрашивается раз в пять секунд: это запрос к базе,
            // и на десятиминутной работе разница между пятью секундами
            // и двумя — это сотня лишних запросов ради задержки, которой
            // человек не заметит.
            ...(kind === "action"
              ? {
                isCancelled: async () => await this.userIsWriting(task, turnStartedAt),
                cancelPollMs: 5_000,
              }
              : {}),
          });
        },
        { userId: Number(task.user_id), conversationId: conversation.conversationId },
      ).finally(() => {
        if (progress) clearTimeout(progress);
      });
      const generatedText = turn.reply.trim();

      // Ход мог упереться в действие, которое человек не разрешал
      // заранее. Тогда он не выполнил работу, а задал вопрос и
      // закончился — и это не отказ: попытка не считается, задача
      // возвращается, когда согласие будет получено.
      if (kind === "action"
        && await this.handledByApproval(task, conversation.conversationId, turnStartedAt)) {
        return;
      }
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
        const sent = await this.deliver(task, generatedText);
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
      // Уступка живому сообщению — не отказ. Работа переделается через
      // пару минут, когда человек получит свой ответ; считать это
      // попыткой значило бы исчерпать их на человеке, который просто
      // разговаривает.
      if (error instanceof EvaError && error.code === "turn_cancelled") {
        await this.yieldToUser(task);
        return;
      }
      await this.failTask(task, kind, error, correlationId);
    }
  }

  /**
   * Отойти в сторону и вернуться позже.
   *
   * Срок сдвигается, попытка не считается, ничего человеку не
   * отправляется: он написал сам и сейчас получит ответ, а сообщение
   * «отложила своё дело» ему в этот момент не нужно.
   */
  private async yieldToUser(task: DueTask): Promise<void> {
    const retryAt = new Date(Date.now() + YIELD_DELAY_MS);
    await this.db.query(
      `
        -- tenant: by task_id — задача принадлежит одному пользователю, проверка владения выше по стеку
        UPDATE tasks SET next_run_at = $2, locked_at = NULL WHERE id = $1 AND user_id = $3`,
      [task.id, retryAt.toISOString(), task.user_id],
    );
    this.logger.info("Задача уступила живому сообщению", { taskId: task.id });
  }

  /**
   * Человек написал, пока Ева делала своё дело.
   *
   * Проверяется непринятое входящее: строка `telegram_updates`, до
   * которой обработчик ещё не дошёл, — она и стоит в очереди за
   * блокировкой, которую держит этот ход. Уступка стоит переделанной
   * работы, ожидание стоит человеку десяти минут молчания в ответ на
   * живое сообщение; второе дороже.
   *
   * Отказ запроса уступкой не считается: потерять ход из-за сорванной
   * проверки хуже, чем один раз не уступить.
   */
  private async userIsWriting(task: DueTask, since: Date): Promise<boolean> {
    try {
      const { rowCount } = await this.db.query(
        `
          -- tenant: by user_id — входящие того же владельца, что и задача
          SELECT 1 FROM telegram_updates
           WHERE user_id = $1
             AND status IN ('queued', 'retry')
             AND received_at >= $2
           LIMIT 1`,
        [task.user_id, since.toISOString()],
      );
      return (rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Сказать, что работа идёт, если она затянулась.
   *
   * Таймер, а не сообщение сразу: длительность заранее неизвестна, и
   * отметка на каждую задачу превратила бы одно обещанное сообщение в
   * два. Отказ доставки молчаливый — это вежливость, а не результат.
   */
  private announceLongWork(task: DueTask): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const language = preferredResponseLanguage({
        language_mode: task.language_mode,
        preferred_language: task.preferred_language,
        last_message_language: task.last_message_language,
        language_code: task.language_code,
      });
      void this.deliver(
        task,
        t(language, "scheduledActionStarted", { title: task.title.slice(0, 200) }),
        "progress",
      ).catch(() => undefined);
    }, LONG_WORK_NOTICE_MS);
    timer.unref();
    return timer;
  }

  /**
   * Ход закончился вопросом к человеку, а не работой.
   *
   * Возвращает `true`, если задачей дальше занимается ожидание
   * согласия: заход не считается ни удачей, ни неудачей. Текст хода при
   * этом не доставляется — человек уже получил сам вопрос, и второе
   * сообщение о том же было бы шумом.
   */
  private async handledByApproval(
    task: DueTask,
    conversationId: string,
    since: Date,
  ): Promise<boolean> {
    const approval = await this.approvals
      ?.lastUnattendedApproval(Number(task.user_id), conversationId, since)
      .catch(() => null);
    if (!approval) return false;

    if (approval.status === "pending") {
      const waits = await this.taskEvents.approvalWaits(
        Number(task.user_id), task.id, task.scheduled_at,
      ) + 1;
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: "action_awaiting_approval", scheduledAt: task.scheduled_at,
        conversationId, metadata: { tool: approval.toolName, waits },
      });
      const retryAt = approvalRetryAt(waits, new Date());
      if (retryAt) {
        await this.db.query(
          `
            -- tenant: by task_id — задача принадлежит одному пользователю, проверка владения выше по стеку
            UPDATE tasks SET next_run_at = $2, locked_at = NULL WHERE id = $1 AND user_id = $3`,
          [task.id, retryAt.toISOString(), task.user_id],
        );
        this.logger.info("Задача ждёт согласия человека", {
          taskId: task.id, tool: approval.toolName, waits,
        });
        return true;
      }
      // Согласия так и не дождались. Молчание на месте обещанного
      // действия выглядит так, будто задачи никогда и не было.
      await this.notifyApprovalOutcome(task, "scheduledActionApprovalTimeout");
      await this.rescheduleTask(task, { error: "approval_timeout" });
      return true;
    }

    // Человек ответил «нет». Возвращаться к тому же действию незачем:
    // ответ уже есть, и повтор выглядел бы как попытка переспросить.
    if (approval.status === "denied" || approval.status === "cancelled") {
      await this.notifyApprovalOutcome(task, "scheduledActionDeclined");
      await this.rescheduleTask(task, { complete: true, error: "approval_denied" });
      return true;
    }
    return false;
  }

  /** Прямой ответ человеку, когда действие так и не состоялось. */
  private async notifyApprovalOutcome(
    task: DueTask,
    key: "scheduledActionApprovalTimeout" | "scheduledActionDeclined",
  ): Promise<void> {
    const language = preferredResponseLanguage({
      language_mode: task.language_mode,
      preferred_language: task.preferred_language,
      last_message_language: task.last_message_language,
      language_code: task.language_code,
    });
    const text = t(language, key, { title: task.title.slice(0, 200) });
    try {
      const sent = await this.deliver(task, text);
      await this.taskEvents.record({
        userId: Number(task.user_id), taskId: task.id,
        eventType: "action_failed", scheduledAt: task.scheduled_at,
        sentAt: new Date(), generatedText: text, deliveryStatus: "fallback",
        telegramChatId: task.chat_id,
        telegramMessageId: lastTelegramMessageId(Array.isArray(sent) ? sent : []),
        errorCode: key === "scheduledActionDeclined" ? "approval_denied" : "approval_timeout",
      });
    } catch (error) {
      this.logger.warn("Итог ожидания согласия не доставлен", {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Доставка результата задачи.
   *
   * Идёт в durable outbox: строка переживает перезапуск, HTTP-запрос из
   * упавшего процесса — нет, а результат действия уже оплачен ходом
   * агента и поиском. Ключ идемпотентности собирается из задачи и её
   * срока — повторный заход того же срока не отправит второе сообщение.
   *
   * Напоминание пропускает вперёд ответ на живой вопрос: человек,
   * который сейчас разговаривает, ждёт именно ответ.
   */
  private async deliver(
    task: DueTask,
    text: string,
    slot = "result",
  ): Promise<unknown> {
    return await this.telegram.withDeliveryContext(
      `task:${task.id}:${new Date(task.scheduled_at).getTime()}:${slot}`,
      async () => await this.telegram.sendMessage(Number(task.chat_id), text),
      "reminder",
    );
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
      const sent = await this.deliver(task, text);
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
