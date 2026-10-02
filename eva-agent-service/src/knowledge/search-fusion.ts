/**
 * Чистые этапы гибридного поиска (docs/knowledge-base.md, «Поиск (K4)»):
 * слияние рангов, разнообразие, сборка ответа в бюджете и ссылка на
 * источник. Без базы и сети — поэтому проверяются по отдельности.
 */

/** Постоянная RRF: шестьдесят сглаживает разницу между списками разной природы. */
export const RRF_K = 60;

/**
 * Бюджет ответа поиска — около 2000 токенов (корневой `CLAUDE.md`,
 * «Бюджеты»). Считается в знаках: около трёх знаков русского текста на
 * токен у современных токенизаторов. Этого хватает на пять фрагментов
 * длины по умолчанию (1200 знаков); соседние добавляются из остатка.
 */
export const KNOWLEDGE_RESULT_CHARS = 6_000;

/** Меньше этого остаток не режется в отдельный кусок: обрывок без смысла хуже, чем ничего. */
const MIN_TRUNCATED_CHARS = 400;
const MIN_NEIGHBOR_CHARS = 200;

export type KnowledgeSignal = "vector" | "fts" | "trgm";

/** Ранжированный список кандидатов одного способа: id фрагментов по убыванию. */
export interface RankedList {
  signal: KnowledgeSignal;
  ids: string[];
  /** Оценка способа: близость вектора, ранг FTS, сходство триграмм. */
  scores?: ReadonlyMap<string, number>;
}

export interface FusedCandidate {
  id: string;
  rrf: number;
  /** Позиция в каждом списке, где кандидат нашёлся (с единицы). */
  ranks: Partial<Record<KnowledgeSignal, number>>;
  scores: Partial<Record<KnowledgeSignal, number>>;
}

/**
 * Reciprocal Rank Fusion: сумма 1/(k + позиция) по спискам. Ранги, а не
 * оценки: близость вектора и `ts_rank` в разных единицах, и сложить их
 * напрямую значило бы отдать победу тому, у кого числа крупнее.
 */
export function fuseRankedLists(lists: readonly RankedList[], k = RRF_K): FusedCandidate[] {
  const fused = new Map<string, FusedCandidate>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.ids.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      const entry = fused.get(id) ?? { id, rrf: 0, ranks: {}, scores: {} };
      entry.rrf += 1 / (k + index + 1);
      entry.ranks[list.signal] = index + 1;
      const score = list.scores?.get(id);
      if (score !== undefined) entry.scores[list.signal] = score;
      fused.set(id, entry);
    });
  }
  // Равные суммы — по id: порядок не должен зависеть от того, в каком
  // порядке пришли списки.
  return [...fused.values()].sort((a, b) => b.rrf - a.rrf || compareIds(a.id, b.id));
}

function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export interface DiversityItem {
  documentId: string;
  contentHash: string;
}

/**
 * Разнообразие: одинаковый текст (тот же файл в личной и в общей базе,
 * повторы внутри документа) — один раз; из одного документа — не больше
 * `maxPerDocument`, пока есть кандидаты из других. Лишние из одного
 * документа не выбрасываются, а встают в конец: если других документов
 * нет, лучше дать ещё фрагмент того же, чем ничего.
 */
export function diversify<T extends DiversityItem>(items: readonly T[], limit: number, maxPerDocument = 3): T[] {
  const chosen: T[] = [];
  const reserve: T[] = [];
  const hashes = new Set<string>();
  const perDocument = new Map<string, number>();
  for (const item of items) {
    if (hashes.has(item.contentHash)) continue;
    hashes.add(item.contentHash);
    const count = perDocument.get(item.documentId) ?? 0;
    if (count >= maxPerDocument) {
      reserve.push(item);
      continue;
    }
    perDocument.set(item.documentId, count + 1);
    chosen.push(item);
  }
  return [...chosen, ...reserve].slice(0, Math.max(0, limit));
}

/**
 * Сколько знаков в начале `next` повторяют конец `previous`. Нарезка
 * начинает фрагмент с хвоста предыдущего (перекрытие), и при склейке
 * соседей этот хвост иначе прозвучал бы дважды.
 */
export function overlapLength(previous: string, next: string, max = 1_000): number {
  const limit = Math.min(previous.length, next.length, max);
  for (let length = limit; length >= 20; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

export interface PassageHit {
  documentId: string;
  ordinal: number;
  content: string;
}

export interface Neighbor {
  documentId: string;
  ordinal: number;
  content: string;
}

export interface Passage<T extends PassageHit> {
  hit: T;
  content: string;
  /** Текст соседних фрагментов до найденного и после — уже без перекрытия. */
  before?: string;
  after?: string;
  truncated: boolean;
}

const key = (documentId: string, ordinal: number): string => `${documentId}#${ordinal}`;

function cut(text: string, max: number, from: "start" | "end"): string {
  if (text.length <= max) return text;
  return from === "start" ? `${text.slice(0, max - 1).trimEnd()}…` : `…${text.slice(text.length - max + 1).trimStart()}`;
}

/**
 * Ответ поиска в бюджете знаков: сначала найденные фрагменты по порядку
 * (последний, который не помещается, укорачивается), потом соседние — по
 * расстоянию от найденного, ближние первыми. Сосед, который сам найден,
 * не повторяется.
 */
export function assemblePassages<T extends PassageHit>(
  hits: readonly T[],
  neighbors: readonly Neighbor[],
  options: { budget?: number; depth: number },
): Passage<T>[] {
  let left = options.budget ?? KNOWLEDGE_RESULT_CHARS;
  const passages: Passage<T>[] = [];
  for (const hit of hits) {
    if (hit.content.length <= left) {
      passages.push({ hit, content: hit.content, truncated: false });
      left -= hit.content.length;
      continue;
    }
    if (left >= MIN_TRUNCATED_CHARS) {
      passages.push({ hit, content: cut(hit.content, left, "start"), truncated: true });
    }
    left = 0;
    break;
  }
  if (left < MIN_NEIGHBOR_CHARS || options.depth <= 0) return passages;

  const byKey = new Map(neighbors.map((item) => [key(item.documentId, item.ordinal), item]));
  const used = new Set(hits.map((hit) => key(hit.documentId, hit.ordinal)));
  const chains = passages.map(() => ({ before: [] as string[], after: [] as string[], first: "", last: "" }));
  passages.forEach((passage, index) => {
    chains[index]!.first = passage.hit.content;
    chains[index]!.last = passage.hit.content;
  });
  for (let distance = 1; distance <= options.depth; distance += 1) {
    for (const [index, passage] of passages.entries()) {
      if (passage.truncated) continue;
      const chain = chains[index]!;
      for (const side of ["before", "after"] as const) {
        if (left < MIN_NEIGHBOR_CHARS) break;
        const ordinal = passage.hit.ordinal + (side === "before" ? -distance : distance);
        const id = key(passage.hit.documentId, ordinal);
        const neighbor = byKey.get(id);
        // Цепочка прервана: соседа нет или он уже показан — дальний
        // без ближнего читался бы как обрывок из другого места.
        if (!neighbor || used.has(id) || (distance > 1 && chain[side].length !== distance - 1)) continue;
        let text = side === "before"
          ? neighbor.content.slice(0, neighbor.content.length - overlapLength(neighbor.content, chain.first))
          : neighbor.content.slice(overlapLength(chain.last, neighbor.content));
        text = text.trim();
        if (!text) continue;
        if (text.length > left) text = cut(text, left, side === "before" ? "end" : "start");
        used.add(id);
        left -= text.length;
        if (side === "before") {
          chain.before.unshift(text);
          chain.first = neighbor.content;
        } else {
          chain.after.push(text);
          chain.last = neighbor.content;
        }
      }
    }
  }
  return passages.map((passage, index) => ({
    ...passage,
    ...(chains[index]!.before.length ? { before: chains[index]!.before.join("\n\n") } : {}),
    ...(chains[index]!.after.length ? { after: chains[index]!.after.join("\n\n") } : {}),
  }));
}

export interface SourceFields {
  documentName: string;
  pageStart: number | null;
  pageEnd: number | null;
  section: string | null;
  subsection: string | null;
  heading: string | null;
}

/** «12» или «12–13»; null — у документа нет страниц (markdown, текст). */
export function pagesOf(source: Pick<SourceFields, "pageStart" | "pageEnd">): string | null {
  if (source.pageStart === null) return null;
  return source.pageEnd !== null && source.pageEnd !== source.pageStart
    ? `${source.pageStart}–${source.pageEnd}`
    : String(source.pageStart);
}

/** Путь заголовков без повторов: «2. Оплата › 2.1 Штрафы». */
export function sectionPathOf(source: Pick<SourceFields, "section" | "subsection" | "heading">): string | null {
  const path = [source.section, source.subsection, source.heading]
    .filter((item, index, all): item is string => Boolean(item) && all.indexOf(item) === index);
  return path.length ? path.join(" › ") : null;
}

/**
 * Ссылка на источник для человека: «Договор.pdf, с. 12–13, раздел
 * „2. Оплата › 2.1 Штрафы“». Ева называет её, когда отвечает по
 * документу, и показывает на «покажи источник».
 */
export function citeOf(source: SourceFields): string {
  const parts = [source.documentName];
  const pages = pagesOf(source);
  if (pages) parts.push(`с. ${pages}`);
  const section = sectionPathOf(source);
  if (section) parts.push(`раздел «${section}»`);
  return parts.join(", ");
}

/**
 * Слова запроса для поиска по триграммам. Триграммы нужны там, где
 * морфология бессильна: обозначения и артикулы («Р-168-5УН», «АБ-12/3»),
 * номера, фамилии и опечатки. Длинный вопрос целиком сравнивать
 * триграммами бессмысленно — у него сходство с любым абзацем низкое, —
 * поэтому берутся только такие слова; короткий запрос (до трёх слов)
 * берётся целиком: в нём каждое слово может быть с опечаткой.
 */
export function trigramTerms(query: string, max = 4): string[] {
  const words = query.match(/[\p{L}\p{N}](?:[\p{L}\p{N}]|[-./_](?=[\p{L}\p{N}]))*/gu) ?? [];
  const identifier = (word: string): boolean =>
    (/\p{N}/u.test(word) && (/\p{L}/u.test(word) || word.length >= 3))
    || /[-./_]/u.test(word)
    || (/[A-Za-z]/u.test(word) && /\p{Script=Cyrillic}/u.test(word))
    || (/^\p{Lu}{2,}$/u.test(word));
  const surname = (word: string, index: number): boolean => index > 0 && /^\p{Lu}\p{Ll}{2,}/u.test(word);
  let terms = words.filter((word, index) => identifier(word) || surname(word, index));
  if (!terms.length && words.length <= 3) terms = words.filter((word) => word.length >= 4);
  const unique: string[] = [];
  for (const term of terms) {
    const clean = term.slice(0, 64);
    if (!unique.some((item) => item.toLowerCase() === clean.toLowerCase())) unique.push(clean);
  }
  return unique.slice(0, max);
}
