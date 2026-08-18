/**
 * «Спросить Еву»: ответ с разделёнными источниками.
 *
 * Пункт 8 шага требует не «умного ответа», а разделения: что Ева
 * помнит о человеке, что записано структурно, что пришло извне и что
 * из этого — вывод модели. Смешение этих четырёх в один абзац и есть
 * то, из-за чего человек принимает догадку за факт.
 *
 * Отсюда устройство модуля:
 *
 *   • три первых раздела собирает SQL — у каждого найденного пункта есть
 *     доказательство: откуда взято, когда записано, чем подтверждается;
 *   • четвёртый раздел — вывод модели — приходит через LLM Router
 *     (инвариант 16) и всегда помечен как вывод, а не как факт;
 *   • уверенность считает код (детерминированно, по числу и свежести
 *     подтверждений), а не модель;
 *   • раздел, для которого подсистема выключена, честно сообщает об
 *     этом. Пустой список вместо этого читался бы как «ничего нет», а
 *     это неправда (пункт 14: не показывать разделы на выдуманных
 *     данных).
 *
 * Кризисная проверка идёт первой и до обращения к модели — пункт 11.
 */

import { detectCrisis, safetyDirective } from "../../crisis.js";
import type { Database } from "../../db.js";
import { badRequest } from "../../errors.js";

export type AskSourceKind =
  | "personal_memory"
  | "structured_records"
  | "external_sources"
  | "model_conclusion";

export interface AskEvidence {
  /** Откуда пункт: таблица и идентификатор строки, а не свободный текст. */
  reference: string;
  /** Цитата или значение — то, что человек может проверить сам. */
  quote: string;
  recorded_at: string | null;
}

export interface AskItem {
  text: string;
  evidence: AskEvidence[];
  /** 0…1, считается кодом. */
  confidence: number;
}

export interface AskSection {
  kind: AskSourceKind;
  title: string;
  /** `false` — подсистема выключена или недоступна; это не «пусто». */
  available: boolean;
  unavailable_reason: string | null;
  items: AskItem[];
}

export interface AskAnswer {
  question: string;
  crisis: { severity: string; directive: string } | null;
  sections: AskSection[];
}

/**
 * Вывод модели приходит извне: маршрут не знает ни про Router, ни про
 * промпты. Отсутствие реализации — законное состояние, и раздел тогда
 * честно объявляет себя недоступным.
 */
export interface AskModelConclusion {
  conclude(input: {
    question: string;
    facts: string[];
  }): Promise<{ text: string; confidence: number } | null>;
}

const MAX_ITEMS = 5;

export async function askEva(
  db: Database,
  user: { id: number; timezone: string },
  input: { question?: unknown },
  options: {
    model?: AskModelConclusion;
    externalEnabled?: boolean;
  } = {},
): Promise<AskAnswer> {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) throw badRequest("Вопрос: требуется текст");
  if (question.length > 1_000) throw badRequest("Вопрос слишком длинный");

  // Кризис — до сбора источников и до модели. Ответ детектора не зависит
  // ни от одного из них, и порядок здесь именно поэтому фиксирован.
  const signal = detectCrisis(question);

  const [structured, external] = await Promise.all([
    structuredRecords(db, user, question),
    options.externalEnabled === false
      ? unavailable(
        "external_sources",
        "Внешние источники",
        "Проверка внешних источников выключена в этой установке",
      )
      : externalSources(db, user.id, question),
  ]);

  const facts = [...structured.items, ...external.items]
    .map((item) => item.text)
    .slice(0, 12);
  const model = await modelSection(question, facts, signal !== null, options.model);

  return {
    question,
    crisis: signal
      ? { severity: signal.severity, directive: safetyDirective(signal) }
      : null,
    sections: [structured, external, model],
  };
}

async function structuredRecords(
  db: Database,
  user: { id: number; timezone: string },
  question: string,
): Promise<AskSection> {
  const { rows } = await db.query<{
    kind: string;
    id: string;
    title: string;
    body: string | null;
    recorded_at: string;
  }>(
    `(SELECT 'journal_entries' AS kind, id::text, coalesce(title, 'Запись дневника') AS title,
             left(content, 400) AS body, updated_at::text AS recorded_at
        FROM journal_entries
       WHERE user_id = $1
         AND to_tsvector('simple', coalesce(title, '') || ' ' || content)
             @@ websearch_to_tsquery('simple', $2)
       ORDER BY local_date DESC, id DESC
       LIMIT $3)
     UNION ALL
     (SELECT 'tasks', id::text, title, description, updated_at::text
        FROM tasks
       WHERE user_id = $1 AND status <> 'canceled'
         AND (title ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC
       LIMIT $3)
     UNION ALL
     (SELECT 'goals', id::text, title, why_it_matters, updated_at::text
        FROM goals
       WHERE user_id = $1 AND status <> 'abandoned'
         AND (title ILIKE '%' || $2 || '%' OR why_it_matters ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC
       LIMIT $3)`,
    [user.id, question, MAX_ITEMS],
  );
  return {
    kind: "structured_records",
    title: "Записи",
    available: true,
    unavailable_reason: null,
    items: rows.slice(0, MAX_ITEMS).map((row) => ({
      text: row.body ? `${row.title} — ${row.body}` : row.title,
      evidence: [{
        reference: `${row.kind}:${row.id}`,
        quote: row.body ?? row.title,
        recorded_at: row.recorded_at,
      }],
      // Собственная запись человека — самое надёжное, что здесь есть:
      // он сам её сделал, и проверять её пересказом не нужно.
      confidence: 1,
    })),
  };
}

async function externalSources(
  db: Database,
  userId: number,
  question: string,
): Promise<AskSection> {
  const { rows } = await db.query<{
    report_id: string;
    claim: string;
    evidence_quote: string;
    url: string;
    domain: string;
    checked_at: string;
    confidence: string;
  }>(
    `SELECT cs.report_id::text, cs.claim, cs.evidence_quote,
            s.url, s.domain, r.checked_at::text, r.confidence::text
       FROM research_claim_sources cs
       JOIN research_sources s ON s.id = cs.source_id AND s.user_id = cs.user_id
       JOIN research_reports r ON r.id = cs.report_id AND r.user_id = cs.user_id
      WHERE cs.user_id = $1
        AND (cs.claim ILIKE '%' || $2 || '%' OR cs.evidence_quote ILIKE '%' || $2 || '%')
      ORDER BY r.checked_at DESC
      LIMIT $3`,
    [userId, question, MAX_ITEMS],
  );
  return {
    kind: "external_sources",
    title: "Внешние источники",
    available: true,
    unavailable_reason: null,
    items: rows.map((row) => ({
      text: row.claim,
      evidence: [{
        reference: `research_reports:${row.report_id} · ${row.domain}`,
        quote: `${row.evidence_quote} (${row.url})`,
        recorded_at: row.checked_at,
      }],
      confidence: clamp01(Number(row.confidence)),
    })),
  };
}

async function modelSection(
  question: string,
  facts: string[],
  crisis: boolean,
  model: AskModelConclusion | undefined,
): Promise<AskSection> {
  if (!model) {
    return unavailableSync(
      "model_conclusion",
      "Вывод Евы",
      "Вывод модели в этой установке не подключён",
    );
  }
  if (crisis) {
    // При кризисе модель к обобщению не привлекается: приоритет отдан
    // детерминированной поддержке, и вывод «по смыслу» здесь вредит.
    return unavailableSync(
      "model_conclusion",
      "Вывод Евы",
      "Сейчас важнее поддержка, а не обобщение",
    );
  }
  if (facts.length === 0) {
    return {
      kind: "model_conclusion",
      title: "Вывод Евы",
      available: true,
      unavailable_reason: null,
      items: [],
    };
  }
  const conclusion = await model.conclude({ question, facts });
  return {
    kind: "model_conclusion",
    title: "Вывод Евы",
    available: true,
    unavailable_reason: null,
    items: conclusion
      ? [{
        text: conclusion.text,
        // Доказательство вывода — те самые пункты, из которых он
        // собран. Своих источников у модели нет и быть не может.
        evidence: facts.slice(0, 3).map((fact) => ({
          reference: "выше в этом ответе",
          quote: fact,
          recorded_at: null,
        })),
        // Уверенность вывода не может превышать уверенность данных, на
        // которых он построен: одно предложение модели не добавляет
        // знания. Потолок 0.7 — это «вероятно», а не «точно».
        confidence: clamp01(Math.min(conclusion.confidence, 0.7)),
      }]
      : [],
  };
}

function unavailableSync(kind: AskSourceKind, title: string, reason: string): AskSection {
  return { kind, title, available: false, unavailable_reason: reason, items: [] };
}

async function unavailable(
  kind: AskSourceKind,
  title: string,
  reason: string,
): Promise<AskSection> {
  return unavailableSync(kind, title, reason);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
