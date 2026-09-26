/**
 * Ева сама рассказывает о завершённом исследовании.
 *
 * Человек попросил найти — и ждёт ответа от Евы, а не шаблона «попросите
 * Еву показать отчёт». Поэтому по завершении идёт служебный ход в
 * основном диалоге: там человек просил исследование, там он и продолжит
 * разговор, и история у Letta будет целой. Что и как пересказать, решает
 * модель по навыку `osint-research` и инструменту `osint_get_report`
 * (инвариант 17); код даёт только повод и идентификатор.
 *
 * В инструкции нет ни запроса человека, ни идентификаторов субъекта —
 * только id исследования. Отчёт модель читает инструментом, как и в
 * обычном ходе.
 *
 * Ход держит блокировку человека (`UserTurnLock`): если человек в эту
 * минуту пишет, пересказ дождётся его хода, а не перебьёт его.
 */

import type { LettaService } from "../letta.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";
import type { UserTurnLock } from "../turns/user-turn-lock.js";
import { isSkipReply } from "../jobs/proactive/skip-marker.js";
import type { Queryable } from "./repository.js";

export interface OsintNarrator {
  /** Текст для человека или `null`, если пересказать нечем. */
  narrate(input: { userId: number; investigationId: string; signal: AbortSignal }): Promise<string | null>;
}

export function osintCompletionInstruction(investigationId: string): string {
  return [
    "[OSINT: ИССЛЕДОВАНИЕ ЗАВЕРШЕНО]",
    `investigation_id: ${investigationId}`,
    "Это служебное сообщение, а не реплика человека: исследование, которое он просил, завершилось.",
    "Получи отчёт инструментом osint_get_report и перескажи человеку главное по правилам навыка osint-research:",
    "что найдено и из каких источников, насколько это надёжно, какие источники не ответили.",
    "Не называй найденный аккаунт принадлежащим человеку, пока отчёт не говорит confirmed или probable.",
    "Не сохраняй сведения о третьих лицах в память. Не ставь напоминаний проверить исследование — оно уже готово.",
    "Ответ — готовое сообщение человеку.",
  ].join("\n");
}

export class LettaOsintNarrator implements OsintNarrator {
  constructor(
    private readonly db: Queryable,
    private readonly letta: Pick<LettaService, "runTurn">,
    private readonly runtimeContext: Pick<RuntimeContextBuilder, "build" | "wrapUserMessage">,
    private readonly lock: Pick<UserTurnLock, "run">,
  ) {}

  async narrate(input: { userId: number; investigationId: string; signal: AbortSignal }): Promise<string | null> {
    const { rows: [link] } = await this.db.query<{ conversation_id: string | null; telegram_id: string | number }>(
      `SELECT a.conversation_id, u.telegram_id
         FROM agent_links a
         JOIN users u ON u.id = a.user_id
        WHERE a.user_id = $1 AND a.kind = 'eva' AND a.status = 'active'
        ORDER BY a.created_at DESC
        LIMIT 1`,
      [input.userId],
    );
    if (!link?.conversation_id) return null;
    const conversationId = link.conversation_id;
    const instruction = osintCompletionInstruction(input.investigationId);
    const context = await this.runtimeContext.build({
      userId: input.userId,
      conversationId,
      userMessage: instruction,
      detectLanguage: false,
    });
    const prompt = this.runtimeContext.wrapUserMessage(context, instruction, {
      internalOperationType: "osint_report",
      correlationId: input.investigationId,
    });
    const turn = await this.lock.run(
      Number(link.telegram_id),
      async () => await this.letta.runTurn(conversationId, prompt, {
        isCancelled: async () => input.signal.aborted,
        cancelPollMs: 2_000,
      }),
      { userId: input.userId, conversationId },
    );
    const reply = turn.reply.trim();
    return isSkipReply(reply) ? null : reply;
  }
}
