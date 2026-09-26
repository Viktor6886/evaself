/**
 * Разрешение вызова в сессии SDK: граница выполнения на хосте и
 * подтверждение человеком.
 *
 * Мост `tool_call` подтверждается по настоящему инструменту: риск,
 * категория, описание и отпечаток аргументов — цели, а не моста. Иначе
 * мост с безобидным именем стал бы обходом подтверждения для любого
 * инструмента за ним. Мост без понятной цели отклоняется, а не
 * пропускается.
 */

import type { CanUseToolCallback } from "@letta-ai/letta-agent-sdk";

import { unwrapBridgeCall } from "./bridge-tools.js";

export function sessionPermission(input: {
  approve: CanUseToolCallback;
  isHostExecutionTool(name: string): boolean;
  onHostExecutionDenied?(name: string): void;
}): CanUseToolCallback {
  return async (requestedTool, requestedInput, context) => {
    const bridged = unwrapBridgeCall(requestedTool, requestedInput);
    if (bridged === "invalid") {
      return { behavior: "deny", message: "tool_call без понятной цели отклонён", interrupt: false };
    }
    const toolName = bridged ? bridged.name : requestedTool;
    const toolInput = bridged ? bridged.arguments : requestedInput;
    // Оболочка и произвольная запись в файловую систему хоста —
    // граница детерминированная, а не предмет подтверждения: за
    // пределами продуктовых сценариев подтверждать такой вызов
    // человеку в чате нечем. Проверка стоит до подтверждений
    // намеренно: при выключенном флаге подтверждений граница обязана
    // остаться.
    if (input.isHostExecutionTool(toolName)) {
      input.onHostExecutionDenied?.(toolName);
      return { behavior: "deny", message: "Инструмент недоступен агенту Евы", interrupt: false };
    }
    return await input.approve(toolName, toolInput, context);
  };
}
