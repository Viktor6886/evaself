/**
 * Каталог отложенных инструментов и поиск по нему.
 *
 * Отложенный инструмент (MCP, браузер) не передаётся Letta полной JSON
 * Schema в каждом ходе: модель видит три моста — `tool_search`,
 * `tool_describe`, `tool_call` — и сама находит, читает и вызывает нужное.
 * Это не выбор инструментов за модель: каталог ничего не решает, он
 * отвечает на запрос, который модель сформулировала сама, как
 * `knowledge_search` отвечает на запрос по базе знаний.
 *
 * Устройство повторяет решения Hermes Agent (tools/tool_search_catalog.py,
 * MIT, Nous Research), переписанные заново под Evaself:
 *
 *   - каталог без состояния: собирается из живого набора инструментов при
 *     каждом обращении. Каталог, закреплённый за сессией, расходится с
 *     реальностью и молча теряет инструменты;
 *   - BM25 по имени, группе, описанию и именам параметров. Тела схем в
 *     индекс не идут: они шум без прироста полноты;
 *   - допуск по самому редкому из слов запроса, встречающихся в
 *     каталоге, а не по `score > 0`: на большом каталоге ненулевой счёт
 *     набирают документы, совпавшие одним общим словом («send», «create»),
 *     и выдача заполняется ими;
 *   - длинный запрос дополнительно требует покрытия половины отвечаемых
 *     слов — иначе модель принимает «что-то нашлось» за «оно здесь есть» и
 *     ищет по кругу.
 *
 * Токенизация своя: русские и английские слова с лёгким снятием
 * окончаний, русская основа — пять букв. Стеммер Snowball, которым
 * пользуется Hermes, — это зависимость ради десятка суффиксов.
 */

export interface CatalogTool {
  name: string;
  description: string;
  /** Группа каталога: `browser`, `mcp:<server>`. */
  group: string;
  parameters: Record<string, unknown>;
}

interface IndexedTool {
  tool: CatalogTool;
  tokens: string[];
}

export interface CatalogIndex {
  entries: IndexedTool[];
  docFreq: Map<string, number>;
  avgLength: number;
}

const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * Окончания, снимаемые при сравнении. Порядок — от длинного к короткому:
 * «ами» должно сняться раньше «и». Лёгкое снятие окончаний, а не
 * морфология: достаточно, чтобы «страницы» нашли «страница», а «issues» —
 * `create_issue`.
 */
const RU_STEM_LENGTH = 5;
const RU_ENDINGS = [
  "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "ией",
  "ах", "ях", "ов", "ев", "ей", "ой", "ий", "ый", "ая", "яя", "ое", "ее",
  "ые", "ие", "ам", "ям", "ом", "ем", "ую", "юю", "у", "ю", "а", "я", "ы",
  "и", "е", "о", "ь",
];

function stemEnglish(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ss|ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

export function stem(token: string): string {
  const word = token.toLowerCase();
  if (!/\p{Script=Cyrillic}/u.test(word)) return stemEnglish(word);
  let root = word;
  for (const ending of RU_ENDINGS) {
    // Корень короче трёх букв — уже не корень: «тест» не должен стать «т».
    if (word.length - ending.length >= 3 && word.endsWith(ending)) { root = word.slice(0, -ending.length); break; }
  }
  // Глагол и причастие одного слова расходятся суффиксами («открыть»,
  // «открывает», «открытой»), и снять их списком окончаний нельзя. Пять
  // букв основы сводят их вместе; точность держат допуск по редкому
  // слову и правило покрытия.
  return root.slice(0, RU_STEM_LENGTH);
}

export function tokenize(text: string): string[] {
  return (text.match(TOKEN) ?? []).map(stem);
}

/** Текст документа: имя без служебного префикса, группа, описание, параметры. */
function searchText(tool: CatalogTool): string {
  const name = tool.name.replace(/^mcp__/, "").replace(/[_.:-]+/g, " ");
  const group = tool.group.replace(/^mcp:/, "").replace(/[_.:-]+/g, " ");
  const properties = tool.parameters.properties;
  const parameterNames = properties && typeof properties === "object" && !Array.isArray(properties)
    ? Object.keys(properties).join(" ")
    : "";
  return `${name} ${group} ${tool.description} ${parameterNames}`;
}

export function buildIndex(tools: readonly CatalogTool[]): CatalogIndex {
  const entries = tools.map((tool) => ({ tool, tokens: tokenize(searchText(tool)) }));
  const docFreq = new Map<string, number>();
  for (const entry of entries) {
    for (const token of new Set(entry.tokens)) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const avgLength = entries.reduce((sum, entry) => sum + entry.tokens.length, 0) / Math.max(entries.length, 1);
  return { entries, docFreq, avgLength };
}

function idf(index: CatalogIndex, token: string): number {
  const n = index.entries.length;
  const df = index.docFreq.get(token) ?? 0;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function bm25(index: CatalogIndex, query: readonly string[], doc: readonly string[]): number {
  const k1 = 1.5;
  const b = 0.75;
  const tf = new Map<string, number>();
  for (const token of doc) tf.set(token, (tf.get(token) ?? 0) + 1);
  let score = 0;
  for (const token of query) {
    const frequency = tf.get(token) ?? 0;
    if (!frequency) continue;
    score += idf(index, token) * frequency * (k1 + 1)
      / (frequency + k1 * (1 - b + b * doc.length / Math.max(index.avgLength, 1)));
  }
  return score;
}

/** Покрытие включается с четырёх отвечаемых слов: короткий запрос законно отличается от инструмента словом. */
function requiredCoverage(answerable: number): number {
  return answerable < 4 ? 1 : Math.ceil(answerable * 0.5);
}

export function searchCatalog(index: CatalogIndex, query: string, limit: number): CatalogTool[] {
  const exact = query.trim().toLowerCase();
  const tokens = [...new Set(tokenize(query))];
  if (!index.entries.length || limit <= 0 || !tokens.length) return [];
  const answerable = tokens.filter((token) => (index.docFreq.get(token) ?? 0) > 0);
  // Слово с наибольшим IDF называет намерение: «github», «браузер»,
  // «issue» разделяют каталог, «read» и «create» — нет. Выбирается оно
  // среди слов, которые в каталоге вообще встречаются: иначе любая иная
  // словоформа запроса по-русски закрывала бы выдачу целиком.
  if (!answerable.length) return exactOnly(index, exact, limit);
  const gate = answerable.reduce((best, token) => (idf(index, token) > idf(index, best) ? token : best), answerable[0]!);
  const coverage = requiredCoverage(answerable.length);
  const scored: Array<{ tool: CatalogTool; score: number }> = [];
  for (const entry of index.entries) {
    const isExact = entry.tool.name.toLowerCase() === exact;
    if (!isExact) {
      const present = new Set(entry.tokens);
      if (!present.has(gate)) continue;
      if (answerable.filter((token) => present.has(token)).length < coverage) continue;
    }
    scored.push({ tool: entry.tool, score: isExact ? Number.POSITIVE_INFINITY : bm25(index, tokens, entry.tokens) });
  }
  scored.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
  return scored.slice(0, limit).map((item) => item.tool);
}

function exactOnly(index: CatalogIndex, exact: string, limit: number): CatalogTool[] {
  return index.entries.filter((entry) => entry.tool.name.toLowerCase() === exact).slice(0, limit).map((entry) => entry.tool);
}

/**
 * Краткий перечень групп для описания `tool_search`: что вообще есть в
 * каталоге. Только группы и числа — имена и схемы модель узнаёт поиском,
 * и описание моста не растёт вместе с каталогом.
 */
export function catalogListing(tools: readonly CatalogTool[], maxGroups = 12): string {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.group, (counts.get(tool.group) ?? 0) + 1);
  const groups = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  const shown = groups.slice(0, maxGroups).map(([group, count]) => `${group} (${count})`);
  const rest = groups.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} и ещё ${rest}` : shown.join(", ");
}
