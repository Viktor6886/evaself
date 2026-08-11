/**
 * Заход проактивного задания.
 *
 * Один метод на все виды: выбрать кандидатов, а дальше — по ступени
 * переноса. В режиме зеркала заход сравнивает свою выборку с выборкой
 * старого интервала и на этом заканчивается; в рабочем режиме — отдаёт
 * кандидатов сервису, который решает по каждому и отправляет.
 *
 * Ход по кандидатам последовательный, а не параллельный: у каждого свой
 * ход агента, и десяток одновременных фоновых ходов занял бы слоты,
 * которые по бюджету принадлежат живым разговорам (раздел «Бюджеты»:
 * не менее 80% слотов интерактивным).
 */

import type { Logger } from "../../logger.js";
import type { MirrorRecorder } from "../mirror.js";
import { compareSelections } from "../mirror.js";
import type { ProactiveKind } from "./policy.js";
import type { ProactiveCandidate, ProactiveService } from "./service.js";
import { type ProactiveSelection, type ReminderCandidate, selectionKeys } from "./selection.js";
import { type ProactiveStage, queueMayDispatch } from "./cutover.js";

export interface ProactiveTickResult {
  kind: ProactiveKind;
  stage: ProactiveStage;
  selected: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Совпала ли выборка со старым механизмом. `null` — сравнение не проводилось. */
  matched: boolean | null;
  /**
   * Можно ли снимать зеркало: серия последних сверок совпала целиком.
   * `null` — вопрос не задавался (сравнения не было или зеркало уже снято).
   */
  readyToCutOver: boolean | null;
}

/** Выборка старого интервала для сравнения. `null` — старого механизма нет. */
export type LegacySelector = (kind: ProactiveKind) => Promise<string[]> | null;

export interface ProactiveRunnerOptions {
  /** Локальный час утреннего и вечернего check-in. */
  morningHour?: number;
  eveningHour?: number;
  /** Сколько кандидатов обрабатывается за заход. */
  batchSize?: number;
  /** Сколько совпавших сверок подряд считать доказательством. */
  cutoverRuns?: number;
}

export class ProactiveRunner {
  private readonly morningHour: number;
  private readonly eveningHour: number;
  private readonly batchSize: number;
  private readonly cutoverRuns: number;

  constructor(
    private readonly selection: ProactiveSelection,
    private readonly service: ProactiveService,
    private readonly mirror: MirrorRecorder,
    private readonly stage: ProactiveStage,
    private readonly logger: Logger,
    private readonly legacySelector: LegacySelector = () => null,
    options: ProactiveRunnerOptions = {},
  ) {
    this.morningHour = options.morningHour ?? 9;
    this.eveningHour = options.eveningHour ?? 21;
    this.batchSize = options.batchSize ?? 25;
    this.cutoverRuns = options.cutoverRuns ?? 20;
  }

  async tick(
    kind: ProactiveKind,
    options: { now?: Date; runId?: string; signal?: AbortSignal } = {},
  ): Promise<ProactiveTickResult> {
    const now = options.now ?? new Date();
    const candidates = await this.select(kind);
    const result: ProactiveTickResult = {
      kind,
      stage: this.stage,
      selected: candidates.length,
      sent: 0,
      skipped: 0,
      failed: 0,
      matched: null,
      readyToCutOver: null,
    };

    const legacy = await this.legacySelector(kind);
    if (legacy) {
      const comparison = compareSelections(kind, legacy, selectionKeys(candidates));
      await this.mirror.record(comparison);
      result.matched = comparison.matched;
      // Готовность к снятию зеркала спрашивается здесь и попадает в
      // журнал: иначе «доказанное совпадение» осталось бы функцией,
      // которую некому вызвать, и решение принималось бы на глаз.
      const readiness = await this.mirror.readyToCutOver(kind, this.cutoverRuns);
      result.readyToCutOver = readiness.ready;
      this.logger.info("Готовность к снятию зеркала", {
        kind,
        ready: readiness.ready,
        runs: readiness.runs,
        mismatches: readiness.mismatches,
        required: this.cutoverRuns,
      });
    }

    if (!queueMayDispatch(this.stage)) {
      // Ступень зеркала: выборка сделана, сравнение записано, и на этом
      // всё. Отправляет по-прежнему старый интервал.
      return result;
    }

    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      const outcome = await this.service.handle(kind, candidate, {
        now,
        runId: options.runId,
        signal: options.signal,
      });
      if (outcome.status === "sent") result.sent += 1;
      else if (outcome.status === "skipped") result.skipped += 1;
      else result.failed += 1;
    }
    this.logger.info("Заход проактивного задания завершён", {
      kind,
      stage: this.stage,
      selected: result.selected,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
    });
    return result;
  }

  private async select(
    kind: ProactiveKind,
  ): Promise<(ProactiveCandidate | ReminderCandidate)[]> {
    if (kind === "reminder") return await this.selection.reminders(this.batchSize);
    if (kind === "heartbeat") return await this.selection.heartbeat(this.batchSize);
    if (kind === "checkin_morning") {
      return await this.selection.checkin(kind, this.morningHour, this.batchSize);
    }
    if (kind === "checkin_evening") {
      return await this.selection.checkin(kind, this.eveningHour, this.batchSize);
    }
    // Ежедневный инсайт и недельный обзор появятся вместе со своими
    // источниками данных (шаги 27 и 54). Пустая выборка здесь — честный
    // ответ «кандидатов нет», а не заглушка.
    return [];
  }
}
