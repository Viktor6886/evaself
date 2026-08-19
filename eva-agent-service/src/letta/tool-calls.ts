/**
 * Что агент действительно вызывал за ход.
 *
 * Спросить у модели, открывала ли она навык, нельзя: ответ будет таким
 * же текстом, как любой другой её текст, и подтверждать его нечем.
 * Источник истины один — поток SDK, где вызов приходит отдельным
 * сообщением `tool_call`, а его исход — сообщением `tool_result` с тем
 * же `toolCallId`.
 *
 * Здесь только метаданные. Аргументы вызова не сохраняются целиком: из
 * них берётся ровно одно поле — имя навыка, и только если оно
 * действительно пришло. Нативный `Skill` в установленном Letta Code
 * 0.30.11 принимает аргумент `skill` (`SkillArgs` в
 * `tools/impl/skill.d.ts`), поэтому имя читается оттуда, а не
 * угадывается по нескольким похожим ключам. Не пришло — значит `null`:
 * выдуманное имя хуже отсутствующего, потому что выглядит как факт.
 */

/** Имя нативного инструмента навыков. Одно, и оно от версии не зависит. */
export const NATIVE_SKILL_TOOL = "Skill";

export interface AgentToolCall {
  toolName: string;
  /** Имя навыка или `null`, если SDK его не назвал. */
  skillName: string | null;
  toolCallId: string;
  runId: string | null;
  /** Итог по `tool_result`; `null` — результата в потоке не было. */
  succeeded: boolean | null;
}

interface ToolCallLike {
  type?: string;
  toolCallId?: unknown;
  toolName?: unknown;
  name?: unknown;
  toolInput?: unknown;
  runId?: unknown;
  isError?: unknown;
}

/**
 * Собрать вызовы инструментов и связать их с результатами.
 *
 * Порядок сообщений в потоке не гарантирован настолько, чтобы полагаться
 * на соседство: результат связывается по `toolCallId`, а не по позиции.
 */
export function collectToolCalls(messages: readonly unknown[]): AgentToolCall[] {
  const calls = new Map<string, AgentToolCall>();
  const results = new Map<string, boolean>();

  for (const raw of messages) {
    const message = (raw ?? {}) as ToolCallLike;
    if (message.type === "tool_call") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const toolName = typeof message.toolName === "string"
        ? message.toolName
        : typeof message.name === "string" ? message.name : "";
      if (!toolCallId || !toolName) continue;
      calls.set(toolCallId, {
        toolName,
        skillName: skillNameOf(toolName, message.toolInput),
        toolCallId,
        runId: typeof message.runId === "string" ? message.runId : null,
        succeeded: null,
      });
      continue;
    }
    if (message.type === "tool_result") {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      if (toolCallId) results.set(toolCallId, message.isError !== true);
    }
  }

  return [...calls.values()].map((call) => ({
    ...call,
    succeeded: results.has(call.toolCallId) ? results.get(call.toolCallId)! : null,
  }));
}

/**
 * Имя навыка из аргументов вызова.
 *
 * Только для нативного `Skill` и только из поля `skill`. У любого
 * другого инструмента поле с таким именем означало бы что-то своё, и
 * записывать его как «открытый навык» значило бы врать телеметрией.
 */
function skillNameOf(toolName: string, toolInput: unknown): string | null {
  if (toolName !== NATIVE_SKILL_TOOL) return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const skill = (toolInput as { skill?: unknown }).skill;
  return typeof skill === "string" && skill.trim() ? skill.trim() : null;
}
