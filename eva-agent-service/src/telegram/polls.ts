/**
 * Нативный опрос Telegram.
 *
 * Опрос — это оформление вопроса, а не второй разговор: Ева называет
 * вопрос и варианты инструментом, Telegram рисует их своим виджетом, а
 * ответ человека возвращается обычным ходом того же разговора.
 *
 * Пределы Bot API проверяются здесь, до отправки: отказ Telegram уже
 * поздно — ход к тому моменту потратил обращение к модели, а человек
 * увидел бы ошибку вместо вопроса. Ошибка отсюда — это ответ
 * инструменту, который модель может исправить сама.
 *
 * По умолчанию опрос неанонимный. Анонимный опрос Telegram присылает
 * без автора: связать ответ с человеком нельзя даже теоретически, и
 * разговор от него ничего не получает. Анонимность остаётся выбором
 * для случаев, когда важно именно не знать автора.
 */

/** Предел Bot API на текст вопроса. */
export const MAX_QUESTION_LENGTH = 300;
/** Предел Bot API на текст одного варианта. */
export const MAX_OPTION_LENGTH = 100;
export const MIN_OPTIONS = 2;
/** Предел Bot API на число вариантов. */
export const MAX_OPTIONS = 10;

export interface NormalizedPoll {
  question: string;
  options: string[];
  isAnonymous: boolean;
  allowsMultiple: boolean;
}

export class PollError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PollError";
  }
}

/** Проверить вопрос и варианты до обращения к Telegram. */
export function normalizePoll(raw: unknown): NormalizedPoll {
  const source = (raw ?? {}) as {
    question?: unknown;
    options?: unknown;
    is_anonymous?: unknown;
    allows_multiple_answers?: unknown;
  };

  const question = typeof source.question === "string" ? source.question.trim() : "";
  if (!question) throw new PollError("question_empty", "Опросу нужен вопрос");
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new PollError(
      "question_too_long",
      `Вопрос длиннее ${MAX_QUESTION_LENGTH} знаков — Telegram его не примет`,
    );
  }

  if (!Array.isArray(source.options)) {
    throw new PollError("options_missing", "Опросу нужны варианты ответа");
  }
  if (source.options.length < MIN_OPTIONS) {
    throw new PollError("options_too_few", `Вариантов должно быть не меньше ${MIN_OPTIONS}`);
  }
  if (source.options.length > MAX_OPTIONS) {
    throw new PollError("options_too_many", `Вариантов должно быть не больше ${MAX_OPTIONS}`);
  }

  const seen = new Set<string>();
  const options = source.options.map((item, index) => {
    const value = typeof item === "string" ? item.trim() : "";
    if (!value) throw new PollError("option_empty", `Вариант ${index + 1} без текста`);
    if (value.length > MAX_OPTION_LENGTH) {
      throw new PollError(
        "option_too_long",
        `Вариант ${index + 1} длиннее ${MAX_OPTION_LENGTH} знаков`,
      );
    }
    if (seen.has(value)) throw new PollError("option_duplicate", `Вариант «${value}» повторяется`);
    seen.add(value);
    return value;
  });

  return {
    question,
    options,
    // Неанонимный по умолчанию: иначе ответ не станет частью разговора.
    isAnonymous: source.is_anonymous === true,
    allowsMultiple: source.allows_multiple_answers === true,
  };
}

/**
 * Назвать выбранные варианты по серверной записи опроса.
 *
 * Тексты берутся из того, что было отправлено, а номера — из апдейта
 * Telegram. Текста из апдейта здесь нет вовсе: Telegram присылает
 * только индексы, и подставлять вместо них что-либо другое значило бы
 * доверять клиенту выбор смысла.
 */
export function namedOptions(options: string[], optionIds: number[]): string[] {
  const named: string[] = [];
  for (const id of optionIds) {
    if (!Number.isInteger(id) || id < 0 || id >= options.length) continue;
    const option = options[id]!;
    if (!named.includes(option)) named.push(option);
  }
  return named;
}

/** Одинаковый ли это выбор. Повтор того же ответа новым ходом не становится. */
export function sameAnswer(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
