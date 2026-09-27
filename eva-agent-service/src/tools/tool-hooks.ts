/**
 * Точки расширения вокруг вызова инструмента: `beforeToolCall`,
 * `afterToolCall`, `onToolError`.
 *
 * Назначение у них служебное — аудит, метрики, квоты, трассировка и
 * задержка. Хук видит только метаданные вызова: имя, источник, группу,
 * владельца, идентификаторы хода и длительность. Ни аргументов, ни
 * результата, ни текста человека в хук не передаётся — поэтому хук не
 * может ни сохранить их, ни отправить в телеметрию (инвариант 19).
 *
 * Хуки регистрирует код сервиса при сборке. Установки хуков из пакетов
 * нет: это не система плагинов, а фиксированный список наблюдателей.
 *
 * Отказ хука — не отказ инструмента. Исключение из хука пишется в журнал
 * и не мешает вызову: учёт, который роняет выполненное действие, делает
 * хуже, чем отсутствие учёта. Запретить вызов хук может только явно —
 * вернув `{ deny }`; так работает квота.
 */

import type { Logger } from "../logger.js";
import type { ToolRisk } from "./approvals.js";
import type { ToolSource } from "./registry.js";

export interface ToolCallInfo {
  name: string;
  source: ToolSource;
  group: string;
  risk: ToolRisk;
  userId: number;
  conversationId: string;
  purpose: string;
  toolCallId: string;
  /** Ход Evaself, если вызов идёт внутри него. */
  runId: string | null;
  /**
   * Каким путём пришёл вызов: прямой вызов модели, мост `tool_call` или
   * рабочий агент делегирования.
   */
  path: ToolCallPath;
  startedAt: number;
}

export type ToolCallPath = "direct" | "bridge" | "delegation";

export interface ToolCallOutcome {
  durationMs: number;
  /** Инструмент ответил `{ ok: false }`: модель получила отказ, а не исключение. */
  refused: boolean;
}

export interface ToolCallFailure {
  durationMs: number;
  /** Имя класса ошибки, а не её текст: текст может нести данные человека. */
  code: string;
}

export interface ToolHooks {
  readonly name: string;
  beforeToolCall?(call: ToolCallInfo): Promise<{ deny: string } | void> | { deny: string } | void;
  afterToolCall?(call: ToolCallInfo, outcome: ToolCallOutcome): Promise<void> | void;
  onToolError?(call: ToolCallInfo, failure: ToolCallFailure): Promise<void> | void;
  /** Вызов остановлен хуком `denied` (квота). Видят все хуки, а не только запретивший. */
  onToolDenied?(call: ToolCallInfo, denied: { hook: string }): Promise<void> | void;
}

export class ToolHookChain {
  constructor(private readonly hooks: readonly ToolHooks[], private readonly logger?: Logger) {}

  get names(): string[] {
    return this.hooks.map((hook) => hook.name);
  }

  /** Первый явный запрет останавливает вызов; исключения хуков — нет. */
  async before(call: ToolCallInfo): Promise<string | null> {
    for (const hook of this.hooks) {
      let verdict: { deny: string } | void;
      try {
        verdict = await hook.beforeToolCall?.(call);
      } catch (error) {
        this.warn(hook.name, "before", error);
        continue;
      }
      if (verdict && typeof verdict.deny === "string") {
        for (const observer of this.hooks) {
          try {
            await observer.onToolDenied?.(call, { hook: hook.name });
          } catch (error) {
            this.warn(observer.name, "denied", error);
          }
        }
        return verdict.deny;
      }
    }
    return null;
  }

  async after(call: ToolCallInfo, outcome: ToolCallOutcome): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.afterToolCall?.(call, outcome);
      } catch (error) {
        this.warn(hook.name, "after", error);
      }
    }
  }

  async error(call: ToolCallInfo, failure: ToolCallFailure): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.onToolError?.(call, failure);
      } catch (error) {
        this.warn(hook.name, "error", error);
      }
    }
  }

  private warn(hook: string, stage: string, error: unknown): void {
    this.logger?.warn("Хук инструмента завершился ошибкой", {
      hook,
      stage,
      code: error instanceof Error ? error.name : "unknown_error",
    });
  }
}
