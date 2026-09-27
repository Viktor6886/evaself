/**
 * Хуки инструментов Evaself: аудит, метрики, квоты, трассировка,
 * задержка.
 *
 * Каждый видит только метаданные вызова (`ToolCallInfo`). Аргументов,
 * результата, адресов страниц и текста человека здесь нет и взять их
 * неоткуда — поэтому ни один хук не может положить их в журнал, метрику
 * или трассу.
 */

import { SpanStatusCode, type Span } from "@opentelemetry/api";

import type { Database } from "../db.js";
import { tracer } from "../observability/tracing.js";
import type { ToolCallInfo, ToolHooks } from "./tool-hooks.js";
import { recordToolCall } from "./tool-metrics.js";

/**
 * Аудит вызовов, которых нет в потоке SDK.
 *
 * Прямой вызов модели Evaself и так записывает в `agent_tool_calls` из
 * потока хода. Вызов через мост поток видит только как `tool_call`, а
 * вызов рабочего агента делегирования в поток Евы не попадает вовсе:
 * настоящий инструмент записывается здесь. Ключ вызова — свой, с именем
 * инструмента: у моста и его цели один идентификатор вызова SDK.
 */
export function auditHook(db: Pick<Database, "recordAgentToolCalls">): ToolHooks {
  const record = async (call: ToolCallInfo, succeeded: boolean): Promise<void> => {
    if (call.path === "direct") return;
    await db.recordAgentToolCalls(call.userId, call.conversationId, [{
      toolName: call.name,
      skillName: null,
      toolCallId: `${call.toolCallId || "no-call-id"}#${call.path}:${call.name}`,
      // `run_id` таблицы — идентификатор run Letta; у моста и
      // делегирования его здесь нет, а номер хода Evaself — другая сущность.
      runId: null,
      succeeded,
    }]);
  };
  return {
    name: "audit",
    afterToolCall: async (call, outcome) => await record(call, !outcome.refused),
    onToolError: async (call) => await record(call, false),
    onToolDenied: async (call) => await record(call, false),
  };
}

export function metricsHook(): ToolHooks {
  return {
    name: "metrics",
    afterToolCall: (call, outcome) => recordToolCall(call.source, call.path, outcome.refused ? "refused" : "ok", outcome.durationMs),
    onToolError: (call, failure) => recordToolCall(call.source, call.path, "error", failure.durationMs),
    onToolDenied: (call) => recordToolCall(call.source, call.path, "denied", 0),
  };
}

/**
 * Квоты вызовов. Это не продуктовая квота тарифа (она у самих
 * инструментов, например поиска), а предохранитель от петли: модель,
 * которая ищет инструмент по кругу, или субагент, листающий сайт
 * бесконечно, упираются в предел и получают объяснение.
 *
 *   - вызовов через мосты и делегирование за один ход — не больше
 *     `perTurn`;
 *   - операций браузера на пользователя за минуту — не больше
 *     `browserPerMinute`.
 *
 * Счётчики в памяти процесса: это восстановимое операционное состояние,
 * потеря которого означает лишь обнулённый предохранитель.
 */
export function quotaHook(options: {
  perTurn: number;
  browserPerMinute: number;
  /**
   * Предел одного делегированного исследования. Субагентов несколько, и
   * каждый законно читает свою пачку страниц: общий с ходом предел
   * обрывал бы исследование на середине.
   */
  perDelegation?: number;
  now?: () => number;
}): ToolHooks & {
  usage(): { turns: number; users: number };
} {
  const now = options.now ?? Date.now;
  const turns = new Map<string, { count: number; seenAt: number }>();
  const browser = new Map<number, number[]>();
  const prune = (at: number): void => {
    for (const [key, value] of turns) if (at - value.seenAt > 3_600_000) turns.delete(key);
    for (const [user, stamps] of browser) {
      const fresh = stamps.filter((stamp) => at - stamp < 60_000);
      if (fresh.length) browser.set(user, fresh);
      else browser.delete(user);
    }
  };
  let calls = 0;
  return {
    name: "quota",
    beforeToolCall: (call) => {
      const at = now();
      if (++calls % 200 === 0) prune(at);
      if (call.path !== "direct") {
        const key = call.runId ?? `${call.path}:${call.conversationId}`;
        const entry = turns.get(key) ?? { count: 0, seenAt: at };
        entry.count += 1;
        entry.seenAt = at;
        turns.set(key, entry);
        const limit = call.path === "delegation" ? options.perDelegation ?? options.perTurn * 4 : options.perTurn;
        if (entry.count > limit) {
          return { deny: `Предел вызовов инструментов за один ход (${limit}) исчерпан. Остановись и ответь тем, что уже известно.` };
        }
      }
      if (call.source === "browser") {
        const stamps = (browser.get(call.userId) ?? []).filter((stamp) => at - stamp < 60_000);
        if (stamps.length >= options.browserPerMinute) {
          browser.set(call.userId, stamps);
          return { deny: `Браузер занят: не больше ${options.browserPerMinute} действий в минуту. Подожди или обойдись найденным.` };
        }
        stamps.push(at);
        browser.set(call.userId, stamps);
      }
      return undefined;
    },
    usage: () => ({ turns: turns.size, users: browser.size }),
  };
}

/**
 * Трасса вызова: span с именем, источником, путём и риском. Без
 * владельца в атрибутах — его и так несёт трасса хода псевдонимом.
 */
export function tracingHook(): ToolHooks {
  const spans = new WeakMap<ToolCallInfo, Span>();
  const end = (call: ToolCallInfo, error: string | null): void => {
    const span = spans.get(call);
    if (!span) return;
    if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.end();
    spans.delete(call);
  };
  return {
    name: "tracing",
    beforeToolCall: (call) => {
      spans.set(call, tracer().startSpan("tool.call", {
        attributes: { "tool.name": call.name, "tool.source": call.source, "tool.path": call.path, "tool.risk": call.risk },
      }));
      return undefined;
    },
    afterToolCall: (call, outcome) => end(call, outcome.refused ? "refused" : null),
    onToolError: (call, failure) => end(call, failure.code),
    onToolDenied: (call) => end(call, "denied"),
  };
}

/**
 * Задержка по инструментам: скользящее окно последних вызовов для
 * панели. Имён ограниченное число — продуктовые, браузер, MCP из
 * политик; сверх предела новые имена не заводятся.
 */
export class ToolLatencyTracker {
  private readonly windows = new Map<string, { source: string; samples: number[]; errors: number; calls: number }>();

  constructor(private readonly options: { window?: number; maxTools?: number } = {}) {}

  hook(): ToolHooks {
    const add = (call: ToolCallInfo, durationMs: number, failed: boolean): void => {
      let entry = this.windows.get(call.name);
      if (!entry) {
        if (this.windows.size >= (this.options.maxTools ?? 300)) return;
        entry = { source: call.source, samples: [], errors: 0, calls: 0 };
        this.windows.set(call.name, entry);
      }
      entry.calls += 1;
      if (failed) entry.errors += 1;
      entry.samples.push(durationMs);
      if (entry.samples.length > (this.options.window ?? 200)) entry.samples.shift();
    };
    return {
      name: "latency",
      afterToolCall: (call, outcome) => add(call, outcome.durationMs, outcome.refused),
      onToolError: (call, failure) => add(call, failure.durationMs, true),
    };
  }

  snapshot(): Array<{ name: string; source: string; calls: number; errors: number; p50Ms: number; p95Ms: number; maxMs: number }> {
    return [...this.windows.entries()].map(([name, entry]) => {
      const sorted = [...entry.samples].sort((left, right) => left - right);
      const at = (quantile: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]! : 0;
      return { name, source: entry.source, calls: entry.calls, errors: entry.errors, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) ?? 0 };
    }).sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
  }
}
