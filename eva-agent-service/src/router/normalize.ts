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

// =====================================================================
// Рассуждения модели не должны доходить до пользователя
// =====================================================================
// Reasoning-модели отдают ход мыслей одним из двух способов:
//
//   1. отдельным полем ответа (reasoning_content, reasoning) — адаптер
//      его просто не читает, и в контент оно не попадает;
//   2. прямо внутри content, обёрнутым в <think>…</think>.
//
// Второй случай возникает, когда модель обслуживают без reasoning-парсера
// (vLLM и SGLang без --reasoning-parser, llama.cpp, часть OpenAI-совместимых
// прокси). Тогда Letta App Server видит рассуждение как обычный текст
// ассистента, сохраняет его в переписку и Ева отправляет всё это в
// Telegram — вместе с ответом и без единого разделителя.
//
// Убирать надо здесь, на границе роутера: ниже по течению рассуждение
// попадает в историю conversation и портит уже не только сообщение, но и
// память агента.

/** Теги, которыми модели оборачивают ход мыслей. */
const REASONING_TAGS = ["think", "thinking", "reason", "reasoning", "thought"];

const REASONING_BLOCK = new RegExp(
  `<(${REASONING_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  "gi",
);

// Незакрытый открывающий тег: поток оборвался на середине рассуждения
// либо модель просто не закрыла блок. Всё после него — не ответ.
const REASONING_OPEN = new RegExp(`<(?:${REASONING_TAGS.join("|")})\\b[^>]*>[\\s\\S]*$`, "i");

// Отдельные модели используют вид <|thinking|> … <|/thinking|>.
const REASONING_PIPE_BLOCK = /<\|(think|thinking|reasoning)\|>[\s\S]*?<\|\/?\1\|>/gi;
const REASONING_PIPE_OPEN = /<\|(?:think|thinking|reasoning)\|>[\s\S]*$/i;

/**
 * Удаляет блоки рассуждений из текста ответа.
 *
 * Возвращает и очищенный текст, и то, что было вырезано: рассуждение
 * пригождается в трассе для администратора, а выбрасывать его молча —
 * значит потерять единственную подсказку, что провайдер вообще думает
 * вслух.
 */
export function stripReasoning(text: string): { content: string; reasoning: string } {
  if (!text || !text.includes("<")) return { content: text, reasoning: "" };

  const captured: string[] = [];
  let out = text.replace(REASONING_PIPE_BLOCK, (match) => {
    captured.push(match);
    return "";
  });
  out = out.replace(REASONING_BLOCK, (match) => {
    captured.push(match);
    return "";
  });

  for (const open of [REASONING_PIPE_OPEN, REASONING_OPEN]) {
    const match = open.exec(out);
    if (match) {
      captured.push(match[0]);
      out = out.slice(0, match.index);
    }
  }

  return { content: out.trim(), reasoning: captured.join("\n").trim() };
}

/**
 * То же для потока: теги приходят разрезанными между чанками.
 *
 * Отдавать наружу можно только тот текст, про который уже точно известно,
 * что он не начало тега. Поэтому «хвост», похожий на незавершённый тег,
 * придерживается до следующего чанка.
 */
export class ReasoningStripper {
  private buffer = "";
  private inside = false;
  private captured: string[] = [];

  /** Возвращает часть текста, которую можно показывать пользователю. */
  push(delta: string): string {
    this.buffer += delta;
    let emitted = "";

    for (;;) {
      if (this.inside) {
        const close = /<\/(?:think|thinking|reason|reasoning|thought)\s*>|<\|\/?(?:think|thinking|reasoning)\|>/i
          .exec(this.buffer);
        if (!close) {
          // Всё ещё внутри блока. Но хвост может быть началом
          // закрывающего тега, разрезанного между чанками («…</thi»):
          // проглотив его целиком, конец блока мы уже не увидим никогда
          // и съедим вместе с рассуждением весь остальной ответ.
          const tail = this.buffer.lastIndexOf("<");
          const keep = tail >= 0 && this.buffer.length - tail <= 14 ? tail : this.buffer.length;
          this.captured.push(this.buffer.slice(0, keep));
          this.buffer = this.buffer.slice(keep);
          return emitted;
        }
        this.captured.push(this.buffer.slice(0, close.index));
        this.buffer = this.buffer.slice(close.index + close[0].length);
        this.inside = false;
        continue;
      }

      const open = /<(?:think|thinking|reason|reasoning|thought)\b[^>]*>|<\|(?:think|thinking|reasoning)\|>/i
        .exec(this.buffer);
      if (open) {
        emitted += this.buffer.slice(0, open.index);
        this.buffer = this.buffer.slice(open.index + open[0].length);
        this.inside = true;
        continue;
      }

      // Тега нет. Возможно, чанк оборвался на его середине — придержим
      // хвост, начинающийся с '<', до следующего чанка.
      const tail = this.buffer.lastIndexOf("<");
      const holdback = tail >= 0 && this.buffer.length - tail <= 12 ? tail : this.buffer.length;
      emitted += this.buffer.slice(0, holdback);
      this.buffer = this.buffer.slice(holdback);
      return emitted;
    }
  }

  /** Остаток после конца потока. Незакрытый блок наружу не отдаётся. */
  flush(): string {
    if (this.inside) {
      this.captured.push(this.buffer);
      this.buffer = "";
      return "";
    }
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  reasoning(): string {
    return this.captured.join("").trim();
  }
}
