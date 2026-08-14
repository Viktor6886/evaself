/**
 * Обсуждение записи дневника.
 *
 * Два правила, и оба держатся кодом, а не просьбой к модели.
 *
 * 1. Кризисная маршрутизация выполняется ДО выбора модели и инструментов
 *    (пункт 11 шага). Поэтому `detectCrisis` вызывается здесь, на входе,
 *    а не где-то внутри обработки хода: к моменту, когда решается, какую
 *    модель и какие инструменты дать, ответ детектора уже есть.
 *
 * 2. Вопрос ровно один (пункт 6). Просьба в директиве — необходимое, но
 *    не достаточное: модель её нарушает. Поэтому есть `limitQuestions` —
 *    детерминированная обрезка, которая применяется к готовому тексту.
 *    Развёрнутый разбор человек запрашивает явно, и тогда ограничение
 *    снимается.
 */

import { detectCrisis, safetyDirective, type CrisisSignal } from "../../crisis.js";
import type { JournalEntry } from "./service.js";

export interface DiscussionRequest {
  /** Текст, который уходит Еве. Сырой reasoning в нём не участвует. */
  prompt: string;
  /** Сколько вопросов допустимо в ответе. */
  question_limit: number;
  /** Кризис найден детектором до всякого обращения к модели. */
  crisis: { severity: CrisisSignal["severity"]; directive: string } | null;
}

const ONE_QUESTION_DIRECTIVE =
  "Ответь коротко и задай не больше одного уточняющего вопроса.";

const DETAILED_DIRECTIVE =
  "Человек попросил развёрнутый разбор: можно задать несколько вопросов.";

/**
 * Сборка обращения к Еве по записи дневника.
 *
 * Запись передаётся целиком: обсуждается именно она, а не пересказ. Всё,
 * что добавляется сверху, — директива о числе вопросов и, если детектор
 * сработал, приоритетная кризисная инструкция.
 */
export function buildDiscussionRequest(
  entry: Pick<JournalEntry, "content" | "title" | "local_date" | "mood">,
  options: { detailed?: boolean } = {},
): DiscussionRequest {
  const detailed = options.detailed === true;
  const signal = detectCrisis(entry.content);
  const header = entry.title
    ? `Запись дневника за ${entry.local_date} — «${entry.title}»:`
    : `Запись дневника за ${entry.local_date}:`;
  const parts = [header, entry.content];
  if (signal) parts.push(safetyDirective(signal));
  parts.push(detailed ? DETAILED_DIRECTIVE : ONE_QUESTION_DIRECTIVE);
  return {
    prompt: parts.join("\n\n"),
    // При кризисе ограничение остаётся одним вопросом даже в
    // развёрнутом режиме: это не разбор, а поддержка, и цепочка вопросов
    // здесь вредна.
    question_limit: signal ? 1 : detailed ? 3 : 1,
    crisis: signal ? { severity: signal.severity, directive: safetyDirective(signal) } : null,
  };
}

/**
 * Обрезка лишних вопросов в готовом ответе.
 *
 * Режется по границе предложения, и режутся именно вопросы: утверждения
 * остаются на месте. Ответ, где вопросов не больше нормы, возвращается
 * без изменений — это важно, чтобы функция была безопасна на любом
 * тексте и её можно было применять всегда.
 */
export function limitQuestions(text: string, limit: number): string {
  if (limit < 0 || !text) return text;
  // Предложение — до знака конца включительно; знаки внутри слова
  // (сокращения, многоточие) не разбивают текст на куски, потому что
  // за ними не следует пробел или конец строки.
  const sentences = text.match(/[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g);
  if (!sentences) return text;
  let seen = 0;
  const kept: string[] = [];
  for (const sentence of sentences) {
    if (/\?\s*$/.test(sentence.trimEnd())) {
      seen += 1;
      if (seen > limit) continue;
    }
    kept.push(sentence);
  }
  if (seen <= limit) return text;
  return kept.join("").trimEnd();
}

/** Сколько вопросов в тексте — для проверок и телеметрии без содержания. */
export function countQuestions(text: string): number {
  const sentences = text.match(/[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [];
  return sentences.filter((sentence) => /\?\s*$/.test(sentence.trimEnd())).length;
}
