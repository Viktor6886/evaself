/**
 * Доставка настроек в media-service.
 *
 * `PUT /config/media` применяется немедленно и переживает перезапуск:
 * сервис хранит переопределения на своём томе. Отправителей у этого
 * запроса стало двое — форма интеграций и переезд на другого бота, —
 * поэтому сам запрос живёт здесь, а не приватным методом одного из них.
 * Второй экземпляр этих же двадцати строк разошёлся бы с первым на
 * первой же правке заголовка или таймаута.
 */

export interface MediaPushResult {
  applied: boolean;
  error?: string;
}

export async function pushMediaConfig(input: {
  baseUrl: string;
  serviceToken: string | null;
  payload: Record<string, Record<string, string>>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Promise<MediaPushResult> {
  const sections = Object.values(input.payload).filter(
    (values) => Object.keys(values).length > 0,
  );
  if (sections.length === 0) return { applied: false };
  if (!input.serviceToken) {
    return { applied: false, error: "MEDIA_SERVICE_TOKEN не задан" };
  }
  const fetcher = input.fetcher ?? fetch;
  try {
    const response = await fetcher(`${input.baseUrl.replace(/\/+$/u, "")}/config/media`, {
      method: "PUT",
      headers: { "content-type": "application/json", "X-Media-Key": input.serviceToken },
      body: JSON.stringify(input.payload),
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      return { applied: false, error: `media-service вернул HTTP ${response.status}` };
    }
    return { applied: true };
  } catch (error) {
    return {
      applied: false,
      error: error instanceof Error ? error.message : "media-service недоступен",
    };
  }
}
