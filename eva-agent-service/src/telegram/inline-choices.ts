/**
 * Кнопки выбора под ответом Евы.
 *
 * Кнопки — оформление ответа, а не отдельное сообщение: Letta называет
 * варианты инструментом, намерение живёт до конца хода, а клавиатура
 * приклеивается к последнему уже отправленному сообщению. Отдельного
 * пузыря «выберите вариант» не появляется.
 *
 * `callback_data` формирует сервер, а не модель. В токене нет ни команды,
 * ни идентификаторов Telegram, ни текста: это непрозрачная случайная
 * строка, а всё остальное лежит в PostgreSQL рядом с владельцем и сроком.
 * Иначе нажатие кнопки было бы способом передать серверу произвольную
 * строку от имени модели.
 */

import { randomBytes } from "node:crypto";

/** Предел Telegram на `callback_data` — 64 байта. Токен занимает меньше. */
export const CALLBACK_DATA_LIMIT = 64;
const TOKEN_BYTES = 16;

/** Сколько вариантов имеет смысл показать в одном ответе. */
export const MAX_CHOICES = 6;
export const MAX_LABEL_LENGTH = 64;
export const MAX_VALUE_LENGTH = 64;

export interface InlineChoice {
  /** Что видит человек на кнопке. */
  label: string;
  /** Что означает выбор для Евы. По умолчанию — сам текст кнопки. */
  value: string;
}

export interface InlineChoiceIntent {
  choices: InlineChoice[];
  /** Одноразовые кнопки снимаются после первого выбора. */
  oneShot: boolean;
}

export class InlineChoiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InlineChoiceError";
  }
}

/**
 * Проверить варианты до того, как они станут клавиатурой.
 *
 * Ошибка здесь — это ответ инструменту, который модель может исправить;
 * отказ Telegram на отправке уже поздно: ответ человеку к тому моменту
 * ушёл бы без кнопок и без объяснения.
 */
export function normalizeChoices(raw: unknown): InlineChoice[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InlineChoiceError("choices_empty", "Нужен хотя бы один вариант выбора");
  }
  if (raw.length > MAX_CHOICES) {
    throw new InlineChoiceError(
      "choices_too_many",
      `Не больше ${MAX_CHOICES} вариантов: длинный список кнопок читается хуже обычного текста`,
    );
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const source = (item ?? {}) as { label?: unknown; value?: unknown };
    const label = typeof source.label === "string" ? source.label.trim() : "";
    if (!label) {
      throw new InlineChoiceError("choice_label_empty", `Вариант ${index + 1} без подписи`);
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new InlineChoiceError(
        "choice_label_too_long",
        `Подпись варианта ${index + 1} длиннее ${MAX_LABEL_LENGTH} знаков`,
      );
    }
    const value = typeof source.value === "string" && source.value.trim()
      ? source.value.trim().slice(0, MAX_VALUE_LENGTH)
      : label;
    if (seen.has(value)) {
      throw new InlineChoiceError("choice_duplicate", `Вариант «${label}» повторяется`);
    }
    seen.add(value);
    return { label, value };
  });
}

/** Непрозрачный токен. Ни смысла, ни владельца в нём нет — только случайность. */
export function newCallbackToken(): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  if (token.length > CALLBACK_DATA_LIMIT) {
    throw new InlineChoiceError("callback_token_too_long", "Токен не помещается в callback_data");
  }
  return token;
}

export interface KeyboardButton {
  text: string;
  callback_data: string;
}

/**
 * Клавиатура из уже выданных токенов.
 *
 * По кнопке в строке: варианты бывают длинными, а Telegram сжимает их в
 * строке до нечитаемого.
 */
export function inlineKeyboard(
  buttons: Array<{ label: string; token: string }>,
): { inline_keyboard: KeyboardButton[][] } {
  return {
    inline_keyboard: buttons.map((button) => [{
      text: button.label,
      callback_data: button.token,
    }]),
  };
}
