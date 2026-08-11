/**
 * Схема результата Memory Curator.
 *
 * Требование 3 шага: результат строго типизирован, свободный текст
 * вместо структуры запрещён, и схема проверяется ДО дальнейшей
 * обработки. Проверяет её серверный код — не модель и не «мягкий»
 * разбор с исправлением почти правильного ответа (инвариант 18).
 *
 * Что здесь НЕ делается: ничего не пишется в базу, ничего не решается о
 * правах и времени. Эта функция превращает строку в проверенную
 * структуру или в код отказа — и всё.
 */

export type CandidateKind = "entity" | "fact" | "relation";

export interface CuratorCandidate {
  kind: CandidateKind;
  /** Тип узла или связи. Проверяется по словарю графа вызывающим. */
  type: string;
  title: string;
  /** Значение факта: то, что человек увидит в Mini App. */
  value: string | null;
  /** Для связи: заголовки концов. Для остальных — пусто. */
  from: string | null;
  to: string | null;
  confidence: number;
  /** Период действительности В ЖИЗНИ пользователя. */
  validFrom: string | null;
  validTo: string | null;
  /** Дата события, если она отличается от даты разговора. */
  eventAt: string | null;
  /** Ссылки на исходные сообщения. Без них кандидат недоказуем. */
  messageIds: string[];
  privacyMode: "normal" | "sensitive" | "private";
  /** Модель считает, что это требует подтверждения человеком. */
  needsConfirmation: boolean;
}

export interface CuratorResult {
  candidates: CuratorCandidate[];
  /** Неопределённые элементы: замечено, но утверждать нечего. */
  uncertain: Array<{ note: string; confidence: number }>;
  empty: boolean;
}

export type CuratorParse =
  | { ok: true; result: CuratorResult }
  | { ok: false; code: string };

const MAX_CANDIDATES = 20;
const MAX_UNCERTAIN = 10;
const MAX_TEXT = 400;

const CANDIDATE_KINDS: ReadonlySet<string> = new Set<CandidateKind>([
  "entity", "fact", "relation",
]);
const PRIVACY_MODES: ReadonlySet<string> = new Set([
  "normal", "sensitive", "private",
]);

/**
 * Разобрать ответ Curator.
 *
 * Ответ, который «почти подходит», отвергается целиком. Принять его
 * значило бы дописать за модель часть структуры — а дальше эта часть
 * попадёт в память как её собственное утверждение.
 */
export function parseCuratorResult(reply: string): CuratorParse {
  const raw = extractJson(reply);
  if (!raw) return { ok: false, code: "curator_result_not_json" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "curator_result_not_json" };
  }
  if (!isRecord(value)) return { ok: false, code: "curator_result_not_object" };

  const rawCandidates = value.candidates;
  if (rawCandidates !== undefined && !Array.isArray(rawCandidates)) {
    return { ok: false, code: "curator_candidates_not_array" };
  }
  const list = Array.isArray(rawCandidates) ? rawCandidates : [];
  if (list.length > MAX_CANDIDATES) {
    return { ok: false, code: "curator_too_many_candidates" };
  }

  const candidates: CuratorCandidate[] = [];
  for (const entry of list) {
    const parsed = parseCandidate(entry);
    if (!parsed.ok) return parsed;
    candidates.push(parsed.candidate);
  }

  const rawUncertain = value.uncertain;
  if (rawUncertain !== undefined && !Array.isArray(rawUncertain)) {
    return { ok: false, code: "curator_uncertain_not_array" };
  }
  const uncertainList = Array.isArray(rawUncertain) ? rawUncertain : [];
  if (uncertainList.length > MAX_UNCERTAIN) {
    return { ok: false, code: "curator_too_many_uncertain" };
  }
  const uncertain: CuratorResult["uncertain"] = [];
  for (const entry of uncertainList) {
    if (!isRecord(entry)) return { ok: false, code: "curator_uncertain_invalid" };
    const note = text(entry.note);
    if (!note) return { ok: false, code: "curator_uncertain_empty" };
    const confidence = confidenceOf(entry.confidence);
    if (confidence === null) return { ok: false, code: "curator_confidence_invalid" };
    uncertain.push({ note, confidence });
  }

  return {
    ok: true,
    result: {
      candidates,
      uncertain,
      empty: candidates.length === 0,
    },
  };
}

type CandidateParse =
  | { ok: true; candidate: CuratorCandidate }
  | { ok: false; code: string };

function parseCandidate(entry: unknown): CandidateParse {
  if (!isRecord(entry)) return { ok: false, code: "curator_candidate_not_object" };

  const kind = typeof entry.kind === "string" ? entry.kind : "";
  if (!CANDIDATE_KINDS.has(kind)) return { ok: false, code: "curator_candidate_kind_unknown" };

  const type = text(entry.type);
  if (!type) return { ok: false, code: "curator_candidate_type_missing" };

  const title = text(entry.title);
  if (!title) return { ok: false, code: "curator_candidate_title_missing" };

  const confidence = confidenceOf(entry.confidence);
  if (confidence === null) return { ok: false, code: "curator_confidence_invalid" };

  const messageIds = stringList(entry.messageIds ?? entry.message_ids);
  // Кандидат без ссылки на источник недоказуем: его нечем подтвердить
  // человеку и нечем дедуплицировать при повторной обработке.
  if (messageIds.length === 0) return { ok: false, code: "curator_candidate_without_source" };

  const privacyRaw = entry.privacyMode ?? entry.privacy_mode ?? "normal";
  const privacyMode = typeof privacyRaw === "string" ? privacyRaw : "";
  if (!PRIVACY_MODES.has(privacyMode)) return { ok: false, code: "curator_privacy_unknown" };

  const validFrom = optionalDate(entry.validFrom ?? entry.valid_from);
  if (validFrom === false) return { ok: false, code: "curator_date_invalid" };
  const validTo = optionalDate(entry.validTo ?? entry.valid_to);
  if (validTo === false) return { ok: false, code: "curator_date_invalid" };
  const eventAt = optionalDate(entry.eventAt ?? entry.event_at);
  if (eventAt === false) return { ok: false, code: "curator_date_invalid" };
  if (validFrom && validTo && new Date(validTo) < new Date(validFrom)) {
    return { ok: false, code: "curator_interval_invalid" };
  }

  if (kind === "relation" && (!text(entry.from) || !text(entry.to))) {
    return { ok: false, code: "curator_relation_incomplete" };
  }

  return {
    ok: true,
    candidate: {
      kind: kind as CandidateKind,
      type,
      title,
      value: text(entry.value) || null,
      from: text(entry.from) || null,
      to: text(entry.to) || null,
      confidence,
      validFrom,
      validTo,
      eventAt,
      messageIds,
      privacyMode: privacyMode as CuratorCandidate["privacyMode"],
      needsConfirmation: entry.needsConfirmation === true || entry.needs_confirmation === true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, MAX_TEXT) : "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 50);
}

function confidenceOf(value: unknown): number | null {
  if (value === undefined || value === null) return 0.5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
  return parsed;
}

/**
 * Дата или её отсутствие. `false` означает «прислана, но нечитаема» —
 * это отказ, а не молчаливое отбрасывание: неразобранная дата в памяти
 * опаснее отсутствующей.
 */
function optionalDate(value: unknown): string | null | false {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString();
}

function extractJson(reply: string): string | null {
  const trimmed = reply.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return null;
  return candidate;
}
