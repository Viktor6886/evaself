/**
 * Темп и способ показа ответа, который растёт на глазах.
 *
 * Прежний показ шагал словами: 5, 9, затем по 14 слов раз в 600 мс.
 * Строка возникала вспышкой, и человек читал ответ рывками. Здесь темп
 * задаётся в знаках в секунду — так пишет человек, — а отставание от
 * модели догоняется плавно: чем больше непоказанного хвоста, тем быстрее
 * показ, без скачка в конце.
 *
 * Способов показа два:
 *
 *  - `edit` — обычное сообщение, которое правится `editMessageText`.
 *    Поле ввода свободно, пока Ева пишет;
 *  - `draft` — черновик бота (`sendMessageDraft`). Telegram сам плавно
 *    анимирует текст и держит его внизу чата, сообщение человека уходит
 *    вверх. Цена: пока черновик открыт, клиент Telegram заменяет кнопку
 *    отправки на «•••». Поэтому режим выбирает администратор.
 */

export type LiveStreamMode = "edit" | "draft";
export type LiveTypingSpeed = "slow" | "calm" | "fast";

/** Знаков в секунду. `fast` — прежний пословный показ, без темпа. */
export const LIVE_TYPING_CPS: Record<Exclude<LiveTypingSpeed, "fast">, number> = {
  slow: 18,
  calm: 25,
};

/**
 * На сколько секунд показ может отстать от модели.
 *
 * Модель пишет быстрее человека. Без догонки хвост копился бы, и в конце
 * его пришлось бы показать разом — ровно тот рывок, от которого уходим.
 * Непоказанное делится на этот срок и прибавляется к темпу: при большом
 * хвосте показ плавно ускоряется.
 */
export const LIVE_MAX_LAG_SECONDS = 6;

/** За сколько дописать хвост, когда модель уже закончила. */
export const LIVE_TAIL_MS = 4_000;

/**
 * Как часто обновляется черновик.
 *
 * Черновик анимирует сам клиент Telegram, поэтому обновлять его можно
 * мельче и чаще, чем править сообщение.
 */
export const LIVE_DRAFT_INTERVAL_MS = 400;

/** Самый длинный промежуток, который засчитывается в одну правку. */
const MAX_ELAPSED_MS = 2_000;

export function parseLiveStreamMode(value: unknown, fallback: LiveStreamMode = "edit"): LiveStreamMode {
  return value === "edit" || value === "draft" ? value : fallback;
}

export function parseLiveTypingSpeed(
  value: unknown,
  fallback: LiveTypingSpeed = "calm",
): LiveTypingSpeed {
  return value === "slow" || value === "calm" || value === "fast" ? value : fallback;
}

/**
 * Сколько знаков показать в эту правку.
 *
 * `elapsedMs` — время с прошлой правки (у первой — интервал показа),
 * `backlog` — сколько знаков ещё не показано, `tailRemainingMs` — сколько
 * осталось на хвост, если модель уже закончила.
 */
export function livePacedChars(input: {
  cps: number;
  elapsedMs: number;
  backlog: number;
  tailRemainingMs: number | null;
}): number {
  const elapsed = Math.min(Math.max(input.elapsedMs, 0), MAX_ELAPSED_MS) / 1_000;
  let rate = input.cps + input.backlog / LIVE_MAX_LAG_SECONDS;
  if (input.tailRemainingMs !== null) {
    rate = Math.max(rate, input.backlog / Math.max(0.25, input.tailRemainingMs / 1_000));
  }
  return Math.max(1, Math.round(rate * elapsed));
}
