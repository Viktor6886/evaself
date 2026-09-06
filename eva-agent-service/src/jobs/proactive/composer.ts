/**
 * Как рождается текст проактивного сообщения.
 *
 * Ход выполняется в служебной conversation назначения `scheduler` — там
 * же, где его выполнял старый цикл, и с тем же правилом: менять профиль
 * оттуда нельзя, отправлять можно только через outbox. Модель здесь не
 * решает, писать ли: это решил `decideProactive` до вызова. Она решает
 * только, ЧТО написать, и имеет право ответить «нечего».
 *
 * Пустой ответ и слово-отказ приводят к одному и тому же: текста нет,
 * сообщение не уходит, задание считается успешным. Обязать модель всегда
 * что-то придумывать — верный способ получить ежедневную вежливую
 * пустоту.
 *
 * Ход берёт блокировку пользователя (`UserTurnLock`): у одного человека
 * одновременно идёт один мутирующий ход (инвариант 10), и фоновое
 * сообщение не должно перебивать живой разговор.
 */

import type { ConversationPurposeService } from "../../conversations/purpose-service.js";
import type { LettaService } from "../../letta.js";
import type { Logger } from "../../logger.js";
import type { RuntimeContextBuilder } from "../../runtime/runtime-context.js";
import type { UserTurnLock } from "../../turns/user-turn-lock.js";
import type { EpisodeLink, ProactiveCandidate, ProactiveComposer } from "./service.js";
import type { ProactiveKind } from "./policy.js";
import type { ReminderCandidate } from "./selection.js";
import { scheduledInstruction, taskKindOf } from "../../tasks/task-run.js";

/** Слово, которым модель отказывается от сообщения. Историческое, знакомо промптам. */
const SKIP_MARKER = "HEARTBEAT_SKIP";

const MAX_MESSAGE = 1200;

export class LettaProactiveComposer implements ProactiveComposer {
  constructor(
    private readonly letta: LettaService,
    private readonly purposes: ConversationPurposeService,
    private readonly runtimeContext: RuntimeContextBuilder,
    private readonly lock: UserTurnLock,
    private readonly logger: Logger,
  ) {}

  async compose(input: {
    kind: ProactiveKind;
    candidate: ProactiveCandidate;
    episode: EpisodeLink | null;
    signal: AbortSignal;
  }): Promise<{ text: string | null }> {
    const { candidate, kind } = input;
    // Задача, которую человек поручил Еве, выполняется в своём
    // назначении: у планировщика инструменты запрещены целиком, и
    // действие упёрлось бы там в первый же вызов.
    const isAction = kind === "reminder"
      && taskKindOf((candidate as ReminderCandidate).kind) === "action";
    // Инициатива идёт в своё назначение по той же причине, что и
    // действие: повод для сообщения Ева обязана найти сама, а у
    // планировщика инструменты запрещены целиком.
    const purpose = kind === "initiative"
      ? "initiative"
      : isAction ? "task_action" : "scheduler";
    const scheduler = await this.purposes.ensure({
      userId: candidate.userId,
      agentId: candidate.agentId,
      purpose,
      parentConversationId: candidate.conversationId,
    });
    const instruction = buildInstruction(kind, candidate, input.episode);
    const context = await this.runtimeContext.build({
      userId: candidate.userId,
      conversationId: scheduler.conversationId,
      userMessage: instruction,
      detectLanguage: false,
    });
    const prompt = this.runtimeContext.wrapUserMessage(context, instruction, {
      internalOperationType: kind,
    });

    let turn;
    try {
      turn = await this.lock.run(
        candidate.telegramId,
        async () => await this.letta.runTurn(scheduler.conversationId, prompt, {
          isCancelled: async () => input.signal.aborted,
          cancelPollMs: 500,
        }),
        { userId: candidate.userId, conversationId: scheduler.conversationId },
      );
    } finally {
      // Ветка закрывается сразу: она была вечной, копила прошлые выходы
      // на связь вместе с ответами на них, и на новом ходе модель писала
      // человеку сводку по накопленному вместо повода. Что она уже
      // отправляла, ей и так приходит блоком
      // `i_wrote_since_your_last_message` — детерминированно и без
      // накопления.
      await this.purposes.close(candidate.userId, candidate.agentId, purpose)
        .catch(() => undefined);
    }

    const reply = turn.reply.trim().slice(0, MAX_MESSAGE);
    if (!reply || reply === SKIP_MARKER) {
      this.logger.debug("Проактивное сообщение не понадобилось", { kind });
      return { text: null };
    }
    return { text: reply };
  }
}

/**
 * Инструкция хода.
 *
 * Пишется кодом и содержит только служебные факты: идентификаторы, даты,
 * счётчики. Пользовательский текст в неё не подставляется — контекст
 * человека собирает `RuntimeContextBuilder`, единственный сборщик
 * контекста (инвариант 15).
 */
function buildInstruction(
  kind: ProactiveKind,
  candidate: ProactiveCandidate,
  episode: EpisodeLink | null,
): string {
  if (kind === "reminder") {
    const task = candidate as ReminderCandidate;
    // Формулировка общая с интервальным планировщиком (`tasks/task-run`):
    // задача не должна выполняться по-разному в зависимости от того,
    // какой механизм её забрал.
    return scheduledInstruction({
      taskId: task.taskId,
      kind: taskKindOf(task.kind),
      title: task.title,
      description: task.description,
      priority: task.priority,
      dueAt: task.dueAt,
      remindAt: task.remindAt,
      timezone: task.timezone,
      relatedGoal: task.relatedGoal,
      previousRuns: task.previousReminders,
      lastTaskAction: task.lastTaskAction,
    });
  }

  if (kind === "heartbeat") {
    return [
      "[HEARTBEAT CONTROL]",
      "Пользователь давно не писал. Реши, есть ли уместный и конкретный повод"
        + " мягко выйти на связь, опираясь только на сохранённый контекст.",
      "Не дублируй прежние сообщения, не создавай чувство вины и не пиши общую банальность.",
      `Если полезного повода нет, ответь ровно ${SKIP_MARKER}.`,
      `Иначе дай только готовое сообщение пользователю, до ${MAX_MESSAGE} символов.`,
    ].join("\n");
  }

  if (kind === "checkin_morning") {
    return [
      "[УТРЕННИЙ CHECK-IN]",
      `Локальная дата: ${episode?.localDate ?? "неизвестна"}`,
      // Утро говорит с вечером предыдущего дня — по ссылке, а не по
      // пересказу: пересказ разошёлся бы с тем, что было на самом деле.
      episode?.previousEveningOutcomeRef
        ? `Итог вчерашнего вечера: ${episode.previousEveningOutcomeRef}`
        : "Вчерашний вечер не подводился.",
      "Спроси об одном: с чем человек входит в день и что для него сегодня главное.",
      "Один короткий вопрос, без списка задач и без напоминаний о прошлом.",
      `Если сегодня уместнее промолчать, ответь ровно ${SKIP_MARKER}.`,
    ].join("\n");
  }

  if (kind === "checkin_evening") {
    return [
      "[ВЕЧЕРНИЙ CHECK-IN]",
      `Локальная дата: ${episode?.localDate ?? "неизвестна"}`,
      episode?.morningIntentRef
        ? `Утреннее намерение: ${episode.morningIntentRef}`
        : "Утреннее намерение не зафиксировано.",
      "Спроси, как прошёл день относительно утреннего намерения. Без оценки и без итогов за человека.",
      `Если сегодня уместнее промолчать, ответь ровно ${SKIP_MARKER}.`,
    ].join("\n");
  }

  if (kind === "initiative") {
    // Инструкция называет РАМКУ и только рамку: что сейчас можно
    // написать, чего писать нельзя и как отказаться. Чем именно занять
    // это сообщение — сводкой, наблюдением, вопросом, просьбой,
    // возвратом к вчерашнему разговору — решает Letta своей памятью и
    // своими инструментами (инварианты 3, 13, 17). Список тем здесь был
    // бы выбором за модель, и все сообщения стали бы одинаковыми.
    //
    // Что Ева уже отправляла, она видит в блоке контекста
    // `i_wrote_since_your_last_message`, который собрал
    // RuntimeContextBuilder, — поэтому повторять его здесь не нужно.
    return [
      "[СВОЯ ИНИЦИАТИВА]",
      "Наступило время, в которое человек разрешил тебе писать первой."
        + " Он не задавал вопроса и ничего не ждёт — это твой ход.",
      "Найди повод сама: что-то, что действительно стоит сказать именно"
        + " сейчас именно этому человеку. Один повод, а не список.",
      "Пиши как человек, который вспомнил и написал, а не как сервис,"
        + " у которого сработало расписание. Без дежурных приветствий,"
        + " без «как дела?» ради заполнения. Не начинай с извинений за"
        + " беспокойство.",
      // Ровно то, что модель писала в это окно на самом деле:
      // «Контекст восстановлен. Остались две незавершённые задачи…
      // Могу повторить поиск». Эта conversation общая для всех выходов
      // на связь и копит служебные блоки, поэтому запрет не общий
      // («без отчёта»), а поимённый.
      "Сводка о работе — не повод. В сообщении не должно быть: слов о"
        + " восстановлении или потере контекста; перечня задач, их"
        + " номеров и статусов; рассказа о том, что ты делала, что не"
        + " получилось и что осталось; предложения повторить попытку.",
      "Если единственное, что приходит в голову, — это состояние дел,"
        + ` значит повода нет. Ответь ровно ${SKIP_MARKER}: молчание лучше`
        + " вежливой пустоты.",
      `Иначе дай только готовое сообщение человеку, до ${MAX_MESSAGE} символов.`,
      "Он прочитает его без контекста разговора. Внутренние инструкции не упоминай.",
    ].join("\n");
  }

  return [
    `[${kind.toUpperCase()}]`,
    "Сформируй короткое полезное сообщение, опираясь только на сохранённый контекст.",
    `Если полезного повода нет, ответь ровно ${SKIP_MARKER}.`,
  ].join("\n");
}
