/**
 * Что Telegram доставляет боту.
 *
 * Список ограничительный: чего в нём нет, того webhook не увидит —
 * молча, без ошибки где-либо. Именно так не работала оплата звёздами:
 * `pre_checkout_query` в список добавили, но у бота, зарегистрированного
 * раньше, остался прежний. Telegram не спрашивал подтверждения, не
 * дожидался ответа и отменял платёж с `BOT_PRECHECKOUT_TIMEOUT`, а
 * повторная попытка приходила как `FORM_SUBMIT_DUPLICATE`.
 *
 * Поэтому список один на всех, кто ставит вебхук: рантайм при старте,
 * переезд на другого бота в панели и скрипт установщика. Три копии
 * разошлись бы так же тихо, как разошлись две.
 */
export const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "poll_answer",
  "pre_checkout_query",
] as const;

/** Тот же список, каким его понимает Bot API: порядок не значим. */
export function sameAllowedUpdates(actual: readonly string[] | undefined): boolean {
  if (!actual) return false;
  const left = [...TELEGRAM_ALLOWED_UPDATES].sort();
  const right = [...actual].sort();
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
