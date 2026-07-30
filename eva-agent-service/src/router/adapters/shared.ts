/** Общее для адаптеров: классификация HTTP-ошибок и чтение SSE. */

import { ProviderError } from "../types.js";

/**
 * Классификация ответа провайдера. От неё зависит, повторять ли запрос тому
 * же провайдеру или сразу идти к резерву, поэтому она одна на все адаптеры.
 */
export function classifyHttp(status: number, message: string, raw: string): ProviderError {
  const detail = (message || raw).slice(0, 300);

  if (status === 429) {
    return new ProviderError(`лимит запросов провайдера: ${detail}`, "rate_limited", {
      retryable: true,
      httpStatus: status,
    });
  }
  if (status === 401 || status === 403) {
    // Ключ не примут и со второй попытки.
    return new ProviderError(`провайдер отклонил ключ: ${detail}`, "quota_exhausted", {
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 402) {
    return new ProviderError(`исчерпан баланс провайдера: ${detail}`, "quota_exhausted", {
      retryable: false,
      httpStatus: status,
    });
  }
  if (status === 400 || status === 422) {
    return new ProviderError(`запрос отклонён: ${detail}`, "model_error", {
      retryable: false,
      httpStatus: status,
      badRequest: true,
    });
  }
  if (status === 404) {
    // Обычно это отсутствующая модель — у другого провайдера она другая.
    return new ProviderError(`модель или маршрут не найдены: ${detail}`, "model_error", {
      retryable: false,
      httpStatus: status,
    });
  }
  if (status >= 500) {
    return new ProviderError(`провайдер вернул ${status}: ${detail}`, "server_error", {
      retryable: true,
      httpStatus: status,
    });
  }
  return new ProviderError(`провайдер вернул ${status}: ${detail}`, "model_error", {
    retryable: false,
    httpStatus: status,
  });
}

/**
 * Разбор text/event-stream в отдельные значения `data:`.
 *
 * Событие может прийти разорванным между чтениями, поэтому буфер режется
 * только по пустой строке — разделителю событий SSE.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = dataOf(block);
        if (data !== null) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }
    const tail = dataOf(buffer);
    if (tail !== null) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function dataOf(block: string): string | null {
  const lines = block.split("\n");
  const payload = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return payload.length > 0 ? payload : null;
}
