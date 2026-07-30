/**
 * Приведение запроса к тому, что целевой провайдер действительно принимает.
 *
 * Требование 1.2: неподдерживаемые параметры удаляются или заменяются
 * безопасными значениями, а не приводят к падению. Требование 1.4: HTTP 400
 * из-за некорректного запроса — повод нормализовать параметры, а не
 * переключаться на резерв.
 */

import type { LlmRequest, LlmTool, ProviderProfile } from "./types.js";

/**
 * Подрезает запрос под возможности провайдера. Возвращает новый объект —
 * исходный запрос принадлежит вызывающему и переиспользуется для следующего
 * провайдера в цепочке.
 */
export function normalizeForProvider(
  request: LlmRequest,
  provider: ProviderProfile,
): LlmRequest {
  const maxTokens = Math.min(
    Math.max(1, request.max_tokens),
    provider.max_output_tokens,
  );

  // Модель без tool calling не должна получать описания инструментов: одни
  // API их молча игнорируют, другие отвечают 400.
  const tools: LlmTool[] = provider.supports_tools ? request.tools : [];

  // То же для строгого JSON. Маршрут json к такому провайдеру не попадёт —
  // фильтр совместимости его отсечёт, — но media-запросы приходят и вне
  // маршрута, и терять их из-за одного поля незачем.
  const responseFormat = provider.supports_json ? request.response_format : null;

  const stream = request.stream && provider.supports_streaming;

  return {
    ...request,
    tools,
    max_tokens: maxTokens,
    response_format: responseFormat,
    stream,
    temperature: clampTemperature(request.temperature),
  };
}

function clampTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(2, Math.max(0, value));
}

/**
 * Вторая попытка после HTTP 400: снимаются ровно те поля, из-за которых
 * запрос чаще всего отвергают, а не всё подряд.
 *
 * Возвращает null, если снимать уже нечего — тогда запрос действительно
 * некорректен и его бессмысленно нести дальше по цепочке.
 */
export function relaxAfterBadRequest(request: LlmRequest): LlmRequest | null {
  if (request.response_format) {
    return { ...request, response_format: null };
  }
  if (request.tools.length > 0) {
    return { ...request, tools: [] };
  }
  if (request.temperature !== 1) {
    return { ...request, temperature: 1 };
  }
  return null;
}

/**
 * Инструкция резерву. Требование 1.8: пользователь не должен заметить
 * переключение, поэтому запасная модель получает те же рамки, что и
 * основная, — но текстом, а не ссылкой на конфигурацию, которой у неё нет.
 */
export const BACKUP_PERSONA_DIRECTIVE = [
  "Ты — Ева: ИИ-компаньон и ассистент по самопознанию.",
  "Сохраняй свою личность и стиль общения: тепло, естественно, кратко.",
  "Не пиши как справочник и не перечисляй пункты без нужды.",
  "Соблюдай ограничения психологической безопасности: не ставь диагнозы,",
  "не давай медицинских назначений, при признаках кризиса удерживай контакт",
  "и предлагай обратиться к живому специалисту.",
  "Продолжай текущую цель разговора, не начинай знакомство заново.",
  "Не упоминай смену модели, провайдера или технические сбои.",
].join(" ");

/**
 * Добавляет инструкцию резерву. Основной провайдер (позиция 0) её не
 * получает: у него личность уже задана системным промптом Letta, и второй
 * экземпляр тех же правил только съедает контекст.
 */
export function withBackupDirective(request: LlmRequest, isBackup: boolean): LlmRequest {
  if (!isBackup) return request;
  const prompt = request.system_prompt.trim();
  return {
    ...request,
    system_prompt: prompt
      ? `${prompt}\n\n${BACKUP_PERSONA_DIRECTIVE}`
      : BACKUP_PERSONA_DIRECTIVE,
  };
}

/**
 * Грубая оценка размера запроса в токенах — только чтобы отсечь провайдера
 * с заведомо недостаточным окном. Точный подсчёт делает сам провайдер и
 * возвращает в usage; здесь важно не ошибиться в меньшую сторону.
 */
export function estimateTokens(request: LlmRequest): number {
  let characters = request.system_prompt.length;
  for (const message of request.messages) {
    characters += message.content.length;
    for (const call of message.tool_calls ?? []) {
      characters += call.name.length + call.arguments.length;
    }
  }
  for (const tool of request.tools) {
    characters += tool.name.length + tool.description.length;
    characters += JSON.stringify(tool.parameters).length;
  }
  // Кириллица в BPE-токенизаторах даёт примерно 2 символа на токен —
  // это нижняя граница, поэтому берём её, а не более щедрые 4.
  return Math.ceil(characters / 2) + request.max_tokens;
}
