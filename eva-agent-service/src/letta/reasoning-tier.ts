/**
 * Уровни reasoning и каталог моделей App Server.
 *
 * Тонкое место, стоившее в своё время всех диалогов сразу. SDK применяет
 * `reasoningEffort` не на ходе, а при инициализации сессии
 * (`applyPostInitializeOptions` → `resolveUpdateModelPayload`), а сами уровни
 * живут в каталоге App Server отдельными записями с
 * `updateArgs.reasoning_effort`. У динамического OpenAI-совместимого
 * провайдера, через который ходит роутер, таких записей нет вовсе — и любое
 * значение кроме `none` роняло открытие сессии. Не ухудшало ответ, а делало
 * разговор недоступным целиком, на каждой холодной сессии.
 *
 * Здесь лежит то, что можно проверить без сети: распознавание этого отказа
 * среди прочих ошибок и сверка уровня с каталогом. Работа с сессией осталась
 * в `letta.ts` — она неотделима от пула.
 */

/** Запись каталога моделей в той части, что нужна для сверки уровня. */
export interface ModelCatalogEntry {
  handle?: string;
  updateArgs?: Record<string, unknown>;
}

/**
 * Отличить отказ применить уровень reasoning от прочих ошибок сессии.
 *
 * Формулировки принадлежат `@letta-ai/letta-agent-sdk`: каталог не знает
 * такого уровня, не знает модели или не смог определить текущую. Во всех трёх
 * случаях сессию имеет смысл переоткрыть без reasoning; любая другая ошибка
 * остаётся ошибкой и подменяться отказом от reasoning не должна — иначе
 * оборванное соединение выглядело бы как проблема настройки.
 */
export function isReasoningTierError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reasoning tier found|reasoningEffort requires/i.test(message);
}

/**
 * Есть ли в каталоге запись, дающая этой модели запрошенный уровень.
 *
 * Сверяется именно пара «модель + уровень»: запись с нужным уровнем у другой
 * модели ничего не обещает активной, и считать её подтверждением значило бы
 * разрешить настройку, которая затем уронит сессию.
 */
export function catalogSupportsEffort(
  entries: readonly ModelCatalogEntry[],
  model: string,
  effort: string,
): boolean {
  return entries.some(
    (entry) => entry.handle === model && entry.updateArgs?.reasoning_effort === effort,
  );
}
