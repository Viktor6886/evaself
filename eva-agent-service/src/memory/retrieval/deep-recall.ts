/**
 * Deep Recall.
 *
 * Отдельный инструмент обращения к истории, а не режим обычного поиска.
 * Разница принципиальная: обычный ход работает на актуальных данных и
 * должен быть дешёвым, а обращение к истории стоит и времени, и
 * бюджета. Поэтому здесь два предмета: решение «нужен ли он сейчас» и
 * собственный бюджет вызова.
 *
 * Решение детерминированное. Спрашивать модель, звать ли Deep Recall,
 * значило бы платить за модель на каждом ходу ровно затем, чтобы узнать,
 * что звать не надо.
 */

import type { HybridRetrieval, RetrievalCandidate } from "./hybrid.js";

export type DeepRecallReason = "explicit_past" | "time_reference" | "context_shortage";

export interface DeepRecallDecision {
  needed: boolean;
  reason: DeepRecallReason | null;
  /** Дата, о которой спрашивают, если её удалось разобрать. */
  asOf: Date | null;
}

export interface DeepRecallBudget {
  maxCandidates: number;
  maxCharacters: number;
  timeoutMs: number;
}

export const DEFAULT_DEEP_RECALL_BUDGET: DeepRecallBudget = {
  maxCandidates: 8,
  maxCharacters: 1_200,
  timeoutMs: 1_500,
};

/** Явный вопрос о прошлом: «помнишь», «раньше», «в прошлый раз». */
const PAST_MARKERS = [
  "помнишь", "напомни", "раньше", "в прошлый раз", "прошлый раз",
  "мы говорили", "ты говорила", "я рассказывал", "я рассказывала",
  "что я говорил", "что я говорила", "тогда",
];

/** Ссылка на время: месяц, год, «на прошлой неделе», дата. */
const TIME_MARKERS = [
  "вчера", "позавчера", "на прошлой неделе", "в прошлом месяце",
  "в прошлом году", "год назад", "месяц назад", "неделю назад",
];

/**
 * Основы названий месяцев. «Май» задан полными формами намеренно:
 * основа «ма» поймала бы «маленький» и «мама» и сдвинула бы разговор в
 * несуществующий май.
 */
const MONTH_STEMS = [
  "январ", "феврал", "март", "апрел", "ма[йея]", "июн",
  "июл", "август", "сентябр", "октябр", "ноябр", "декабр",
] as const;

/**
 * Нужен ли Deep Recall на этом сообщении.
 *
 * Три повода из задания: явный вопрос о прошлом, обнаруженная ссылка на
 * время и нехватка контекста. Ни один из них не наступает на обычном
 * сообщении — поэтому на обычном ходу инструмент не вызывается.
 */
export function decideDeepRecall(input: {
  message: string;
  contextCandidates: number;
  now?: Date;
}): DeepRecallDecision {
  const message = input.message.toLocaleLowerCase("ru");
  const asOf = parseAsOf(message, input.now ?? new Date());
  if (PAST_MARKERS.some((marker) => message.includes(marker))) {
    return { needed: true, reason: "explicit_past", asOf };
  }
  if (asOf || TIME_MARKERS.some((marker) => message.includes(marker))) {
    return { needed: true, reason: "time_reference", asOf };
  }
  // Нехватка контекста: сборщик не нашёл ничего, а вопрос задан. Это
  // именно нехватка, а не пустая память — пустая память даёт тот же
  // ноль, и Deep Recall честно вернёт ноль же, но один раз.
  if (input.contextCandidates === 0 && message.includes("?")) {
    return { needed: true, reason: "context_shortage", asOf: null };
  }
  return { needed: false, reason: null, asOf: null };
}

/** Дата из сообщения: «в марте 2023», «12.03.2023», «в 2021». */
export function parseAsOf(message: string, now: Date): Date | null {
  const explicit = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(message);
  if (explicit) {
    const date = new Date(Date.UTC(
      Number(explicit[3]), Number(explicit[2]) - 1, Number(explicit[1]),
    ));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  // Месяц берётся только с начала слова: иначе основа находилась бы
  // внутри чужого слова и уводила разговор в чужую дату.
  const months = new RegExp(
    `(?:^|[^\\p{L}])(${MONTH_STEMS.join("|")})\\p{L}*\\s*(\\d{4})?`, "u",
  ).exec(message);
  if (months) {
    const index = MONTH_STEMS.findIndex((stem) => new RegExp(`^(?:${stem})`, "u").test(months[1]!));
    if (index >= 0) {
      const year = months[2] ? Number(months[2]) : now.getUTCFullYear();
      return new Date(Date.UTC(year, index, 1));
    }
  }
  const year = /\b(19|20)(\d{2})\s*(год|году|г\.)/.exec(message);
  if (year) return new Date(Date.UTC(Number(`${year[1]}${year[2]}`), 0, 1));
  return null;
}

export class DeepRecall {
  constructor(
    private readonly retrieval: HybridRetrieval,
    private readonly enabled: boolean,
    private readonly budget: DeepRecallBudget = DEFAULT_DEEP_RECALL_BUDGET,
  ) {}

  get active(): boolean {
    return this.enabled && this.retrieval.active;
  }

  /**
   * Вызвать инструмент.
   *
   * Возвращает уже урезанные под бюджет строки: ограничивать их на
   * стороне вызывающего значило бы платить за выбранное и выбросить.
   */
  async recall(input: {
    userId: number;
    message: string;
    decision: DeepRecallDecision;
    vector?: readonly number[] | null;
    signal?: AbortSignal;
  }): Promise<{ lines: string[]; candidates: RetrievalCandidate[]; degraded: boolean }> {
    if (!this.active || !input.decision.needed) {
      return { lines: [], candidates: [], degraded: false };
    }
    const result = await this.retrieval.search({
      userId: input.userId,
      text: input.message,
      limit: this.budget.maxCandidates,
      asOf: input.decision.asOf,
      vector: input.vector ?? null,
      signal: input.signal,
    });
    const lines: string[] = [];
    let characters = 0;
    for (const candidate of result.candidates) {
      const line = `${candidate.title}${candidate.text ? `: ${candidate.text}` : ""}`
        .replace(/\s+/g, " ").trim();
      // Слишком длинный кандидат пропускается, а не обрывает выборку:
      // иначе один многословный факт съедал бы весь вызов и человек
      // получал бы пустое «не помню» при полной памяти.
      if (characters + line.length > this.budget.maxCharacters) continue;
      characters += line.length;
      lines.push(line);
    }
    return { lines, candidates: result.candidates, degraded: result.degraded };
  }
}
