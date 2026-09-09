/**
 * Заход инициативы: разложить окна по минутам и отправить наступившие.
 *
 * Две работы в одном заходе намеренно. Они дёшевы порознь (индексный
 * запрос и пустая выборка в обычную минуту) и обязаны идти в одном
 * порядке: окно, созданное человеком в 10:40 на 11:00–12:00, должно
 * успеть разложиться до того, как диспетчер спросит о наступивших.
 *
 * Владелец у этой работы один. Старого интервала у инициативы нет —
 * её не было вовсе, — поэтому режим зеркала здесь не нужен и сравнивать
 * не с чем. Но механизмов запуска два, и одновременно они не работают
 * никогда: пока ступень переноса `legacy` или `mirror`, заход делают
 * интервалы `BackgroundRuntime`; после снятия зеркала интервалы не
 * стартуют, и заход делает задание очереди (инвариант 9).
 *
 * Кандидаты обрабатываются последовательно: у каждого свой ход агента,
 * и десяток одновременных фоновых ходов занял бы слоты, которые по
 * бюджету принадлежат живым разговорам.
 */

import type { Logger } from "../../logger.js";
import type { ProactiveService } from "./service.js";
import type { InitiativeSelection } from "./selection.js";
import type { ProactiveWindowPlanner } from "./windows.js";

export interface InitiativeTickResult {
  /** Окон, для которых на сегодня выбрана минута. */
  planned: number;
  /** Наступивших окон, взятых в работу. */
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

export class ProactiveInitiativeRunner {
  constructor(
    private readonly planner: ProactiveWindowPlanner,
    private readonly selection: InitiativeSelection,
    private readonly service: ProactiveService,
    private readonly logger: Logger,
    private readonly batchSize = 25,
  ) {}

  async tick(
    options: { now?: Date; runId?: string; signal?: AbortSignal } = {},
  ): Promise<InitiativeTickResult> {
    const now = options.now ?? new Date();
    const result: InitiativeTickResult = {
      planned: 0, due: 0, sent: 0, skipped: 0, failed: 0,
    };

    // Отказ раскладки не отменяет отправку уже разложенного: минуты
    // сегодняшнего дня выбраны на прошлом заходе, и человек ждёт их, а
    // не завтрашних.
    try {
      result.planned = await this.planner.plan(undefined, now);
    } catch (error) {
      this.logger.warn("Окна инициативы не разложены", {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const candidates = await this.selection.due(this.batchSize);
    result.due = candidates.length;
    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      const outcome = await this.service.handleScheduled(candidate, {
        now,
        runId: options.runId,
        signal: options.signal,
      });
      if (outcome.status === "sent") result.sent += 1;
      else if (outcome.status === "skipped") result.skipped += 1;
      else result.failed += 1;
    }

    if (result.due > 0) {
      this.logger.info("Заход инициативы завершён", {
        planned: result.planned,
        due: result.due,
        sent: result.sent,
        skipped: result.skipped,
        failed: result.failed,
      });
    }
    return result;
  }
}
