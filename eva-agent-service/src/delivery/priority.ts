/**
 * Приоритет доставки.
 *
 * Очередь доставки не равноправна. Когда она короткая, порядок не
 * заметен; когда длинная — разница между кризисным сообщением и
 * «печатает…» становится разницей между вовремя и никогда.
 *
 * Ступени заданы шагом 06 и идут по убыванию важности: кризис, готовый
 * ответ человеку, команды и платежи, напоминания, служебные статусы.
 * Числа с шагом 10 — чтобы между ступенями оставалось место, если
 * когда-нибудь понадобится вклиниться, не переписывая существующие
 * строки.
 */

export const DELIVERY_PRIORITIES = ["crisis", "reply", "command", "reminder", "status"] as const;

export type DeliveryPriority = (typeof DELIVERY_PRIORITIES)[number];

export const PRIORITY_VALUE: Record<DeliveryPriority, number> = {
  crisis: 10,
  reply: 20,
  command: 30,
  reminder: 40,
  status: 50,
};

/**
 * Методы, которые сами по себе служебные: их содержание — не сообщение
 * человеку, а отметка о состоянии. Опоздав, они бесполезны, поэтому
 * пропускают вперёд всё остальное.
 */
const STATUS_METHODS = new Set([
  "sendChatAction",
  "setMessageReaction",
  "deleteMessage",
  "editMessageReplyMarkup",
]);

/**
 * Приоритет по методу, когда вызывающий ничего не сказал.
 *
 * Умолчание — `reply`: строка, поставленная в очередь без объяснений,
 * это ответ человеку. Ошибиться в эту сторону безопаснее, чем отложить
 * ответ, приняв его за фоновую мелочь.
 */
export function priorityOfMethod(method: string): DeliveryPriority {
  return STATUS_METHODS.has(method) ? "status" : "reply";
}

export function priorityValue(priority: DeliveryPriority | undefined, method: string): number {
  return PRIORITY_VALUE[priority ?? priorityOfMethod(method)];
}
