/**
 * Разбор SQL до его выполнения: какие пользовательские таблицы затронуты
 * и ограничен ли доступ к каждой из них столбцом владельца.
 *
 * Это не полноценный парсер PostgreSQL и он им быть не должен. Задача
 * узкая: увидеть в тексте запроса связь «таблица — столбец владельца —
 * значение». Всё, что разобрать не удалось, считается НЕограниченным.
 * Ошибка в сторону отказа безопасна: запрос не выполнится и это станет
 * видно на тестах, а не утечкой в production.
 *
 * Разбор статический, поэтому его результат проверяется не только в
 * рантайме: тест `tenant-isolation.test.ts` прогоняет анализатор по
 * всему исходному коду и требует, чтобы каждый запрос к пользовательской
 * таблице либо имел границу арендатора, либо был явно объявлен
 * системным или административным.
 */

import {
  isTenantTable,
  MULTI_PARTY_TABLES,
  TELEGRAM_COLUMNS,
  tenantColumns,
} from "./tables.js";

/** Как значение владельца попало в запрос. */
export type TenantBinding =
  | { kind: "parameter"; column: string; index: number }
  | { kind: "literal"; column: string; value: number }
  | { kind: "expression"; column: string };

export interface TenantTableUse {
  table: string;
  alias: string;
  scoped: boolean;
  bindings: TenantBinding[];
}

export interface SqlAnalysis {
  /** Пользовательские таблицы, встреченные в запросе. */
  uses: TenantTableUse[];
  /** Имена таблиц без границы арендатора. */
  unscoped: string[];
  /** Все привязки значений владельца — по ним идёт сверка со scope. */
  bindings: TenantBinding[];
}

const IDENTIFIER = "[a-z_][a-z_0-9]*";

/**
 * Слова, которые стоят там же, где мог бы стоять алиас. Без этого списка
 * `FROM users WHERE ...` дал бы таблице алиас `where`.
 */
const NOT_AN_ALIAS = new Set([
  "as", "on", "using", "where", "set", "values", "select", "from", "join",
  "left", "right", "inner", "outer", "full", "cross", "lateral", "natural",
  "group", "order", "limit", "offset", "having", "window", "union", "except",
  "intersect", "returning", "for", "with", "and", "or", "not", "conflict",
  "do", "nothing", "update", "insert", "delete", "into", "fetch", "only",
  "tablesample", "at", "by", "distinct", "all",
]);

/**
 * Текст запроса без строковых литералов, комментариев и подстановок
 * `${...}`: они не должны попадать в разбор ни как таблицы, ни как
 * привязки. Длина сохраняется, чтобы позиции символов не поехали.
 */
function normalize(sql: string): string {
  let result = sql
    .replace(/--[^\n]*/g, (match) => " ".repeat(match.length))
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/'(?:[^']|'')*'/g, (match) => `'${" ".repeat(Math.max(0, match.length - 2))}'`)
    .replace(/"(?:[^"]|"")*"/g, (match) => `"${" ".repeat(Math.max(0, match.length - 2))}"`)
    .replace(/\$\{[^}]*\}/g, (match) => " ".repeat(match.length));
  result = result.toLowerCase();
  return result;
}

/** Имена CTE: `WITH x AS (...)`, `x(...) AS (...)`, рекурсивные тоже. */
function cteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const withMatch = /\bwith\s+(recursive\s+)?/g;
  let match: RegExpExecArray | null;
  while ((match = withMatch.exec(sql)) !== null) {
    // Имена CTE идут через запятую на верхнем уровне вложенности.
    let depth = 0;
    let expectName = true;
    const tail = sql.slice(match.index + match[0].length);
    const token = new RegExp(`${IDENTIFIER}|\\(|\\)|,`, "g");
    let item: RegExpExecArray | null;
    while ((item = token.exec(tail)) !== null) {
      const text = item[0];
      if (text === "(") depth += 1;
      else if (text === ")") depth -= 1;
      else if (text === ",") { if (depth === 0) expectName = true; }
      else if (depth === 0) {
        if (expectName) {
          names.add(text);
          expectName = false;
        } else if (text !== "as" && text !== "materialized" && text !== "not") {
          break;
        }
      }
      if (depth < 0) break;
    }
  }
  return names;
}

interface TableRef {
  table: string;
  alias: string;
  at: number;
}

function tableRefs(sql: string, ignore: Set<string>): TableRef[] {
  const pattern = new RegExp(
    `\\b(?:from|join|update|into)\\s+(?:only\\s+)?(${IDENTIFIER})` +
    `(?:\\s+(?:as\\s+)?(${IDENTIFIER}))?`,
    "g",
  );
  const refs: TableRef[] = [];
  refs.push(...commaJoins(sql, ignore));
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    const table = match[1]!;
    if (ignore.has(table)) continue;
    const candidate = match[2];
    const keyword = candidate !== undefined && NOT_AN_ALIAS.has(candidate);
    if (keyword) {
      // Слово на месте алиаса оказалось ключевым — вернуть его в разбор.
      // Иначе `FROM a JOIN b` съедало бы `JOIN` вместе с алиасом, и
      // таблица `b` не попадала бы в анализ вовсе: запрос выглядел бы
      // ограниченным, не будучи им.
      pattern.lastIndex = match.index + match[0].length - candidate!.length;
    }
    const alias = candidate !== undefined && !keyword ? candidate : table;
    refs.push({ table, alias, at: match.index });
  }
  return refs;
}

/**
 * Таблицы, перечисленные через запятую: `FROM tasks t, goals g`.
 *
 * Основной разбор идёт по ключевым словам FROM/JOIN, поэтому вторая и
 * следующие таблицы списка иначе не попали бы в анализ вовсе — запрос
 * выглядел бы ограниченным, не будучи им. Просматривается только отрезок
 * между `FROM` и ближайшим словом, закрывающим список.
 */
function commaJoins(sql: string, ignore: Set<string>): TableRef[] {
  const refs: TableRef[] = [];
  const clause = /\bfrom\b/g;
  const stop = new RegExp(
    `\\b(where|group|order|limit|offset|having|window|union|except|intersect|` +
    `returning|join|left|right|inner|outer|full|cross|natural|on|using|set|values)\\b`,
  );
  let start: RegExpExecArray | null;
  while ((start = clause.exec(sql)) !== null) {
    const rest = sql.slice(start.index + start[0].length);
    const end = stop.exec(rest);
    const list = rest.slice(0, end ? end.index : rest.length);
    const offset = start.index + start[0].length;
    const item = new RegExp(
      `,\\s*(${IDENTIFIER})(?:\\s+(?:as\\s+)?(${IDENTIFIER}))?`,
      "g",
    );
    let found: RegExpExecArray | null;
    while ((found = item.exec(list)) !== null) {
      const table = found[1]!;
      if (ignore.has(table) || !isTenantTable(table)) continue;
      const candidate = found[2];
      const alias = candidate && !NOT_AN_ALIAS.has(candidate) ? candidate : table;
      refs.push({ table, alias, at: offset + found.index });
    }
  }
  return refs;
}

/**
 * Значение столбца владельца в INSERT.
 *
 * `INSERT INTO t (a, user_id, b) VALUES ($1, $2, $3)` — берём выражение,
 * стоящее на позиции столбца. `INSERT INTO t (user_id, …) SELECT id, …
 * FROM users WHERE telegram_id = $1` — позиция указывает на выражение
 * SELECT, значение приходит не параметром, и такой запрос ограничен
 * ровно настолько, насколько ограничен его источник.
 */
function insertBindings(sql: string, table: string, columns: readonly string[]): TenantBinding[] {
  const header = new RegExp(`insert\\s+into\\s+${table}\\s*\\(([^)]*)\\)`, "g");
  const bindings: TenantBinding[] = [];
  let match: RegExpExecArray | null;
  while ((match = header.exec(sql)) !== null) {
    const names = match[1]!.split(",").map((item) => item.trim());
    const tail = sql.slice(match.index + match[0].length);
    const values = /^\s*values\s*\(([\s\S]*?)\)/.exec(tail);
    const selected = values ? null : /^\s*select\s+([\s\S]*?)\s+from\s/.exec(tail);
    for (const column of columns) {
      const position = names.indexOf(column);
      if (position < 0) continue;
      const list = values?.[1] ?? selected?.[1] ?? null;
      if (list === null) {
        // Источник разобрать не удалось: границу даёт он, а не эта позиция.
        bindings.push({ kind: "expression", column });
        continue;
      }
      const expression = splitTopLevel(list)[position]?.trim() ?? "";
      const parameter = /^\$(\d+)$/.exec(expression);
      if (parameter) {
        bindings.push({ kind: "parameter", column, index: Number(parameter[1]) });
      } else if (/^\d+$/.test(expression)) {
        bindings.push({ kind: "literal", column, value: Number(expression) });
      } else {
        bindings.push({ kind: "expression", column });
      }
    }
  }
  return bindings;
}

function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of list) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Группы связанных между собой пар «таблица.столбец». */
class Links {
  private readonly parent = new Map<string, string>();

  private find(key: string): string {
    const seen = this.parent.get(key);
    if (seen === undefined || seen === key) {
      this.parent.set(key, key);
      return key;
    }
    const root = this.find(seen);
    this.parent.set(key, root);
    return root;
  }

  join(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parent.set(a, b);
  }

  same(left: string, right: string): boolean {
    return this.find(left) === this.find(right);
  }
}

export function analyzeSql(sql: string): SqlAnalysis {
  const text = normalize(sql);
  const refs = tableRefs(text, cteNames(text));
  const tenantRefs = refs.filter((ref) => isTenantTable(ref.table));
  if (tenantRefs.length === 0) {
    return { uses: [], unscoped: [], bindings: [] };
  }

  const aliasToTable = new Map<string, string>();
  for (const ref of refs) aliasToTable.set(ref.alias, ref.table);

  /**
   * Неквалифицированный столбец относится к ближайшей таблице слева:
   * `… FROM goal_results WHERE user_id = g.user_id` пишут именно так.
   * Если слева таблицы нет, привязка не засчитывается вовсе.
   */
  const enclosing = (position: number): TableRef | null => {
    let found: TableRef | null = null;
    for (const ref of refs) {
      if (ref.at > position) break;
      found = ref;
    }
    return found;
  };

  const links = new Links();
  // Разные столбцы владельца одной и той же строки указывают на одного
  // человека: `users.id` и `users.telegram_id` — это один пользователь.
  for (const ref of tenantRefs) {
    if (MULTI_PARTY_TABLES.has(ref.table)) continue;
    const columns = tenantColumns(ref.table)!;
    for (const column of columns.slice(1)) {
      links.join(`${ref.alias}.${columns[0]!}`, `${ref.alias}.${column}`);
    }
  }
  const anchored = new Map<string, TenantBinding[]>();
  const anchor = (alias: string, binding: TenantBinding) => {
    const key = `${alias}.${binding.column}`;
    const list = anchored.get(key) ?? [];
    list.push(binding);
    anchored.set(key, list);
  };

  // Привязки в условиях: столбец = параметр, число или другой столбец.
  const comparison = new RegExp(
    `(?:(${IDENTIFIER})\\.)?(${IDENTIFIER})\\s*=\\s*` +
    `(?:\\$(\\d+)|(\\d+)|(?:(${IDENTIFIER})\\.)?(${IDENTIFIER}))`,
    "g",
  );
  let match: RegExpExecArray | null;
  while ((match = comparison.exec(text)) !== null) {
    const leftColumn = match[2]!;
    const leftAlias = match[1] ?? enclosing(match.index)?.alias ?? null;
    if (leftAlias === null) continue;
    const leftTable = aliasToTable.get(leftAlias);
    const rightAlias = match[5] ?? enclosing(match.index)?.alias ?? null;
    const rightColumn = match[6] ?? null;

    const leftIsTenant =
      leftTable !== undefined &&
      (tenantColumns(leftTable)?.includes(leftColumn) ?? false);

    if (match[3] !== undefined) {
      if (leftIsTenant) {
        anchor(leftAlias, { kind: "parameter", column: leftColumn, index: Number(match[3]) });
      }
      continue;
    }
    if (match[4] !== undefined) {
      if (leftIsTenant) {
        anchor(leftAlias, { kind: "literal", column: leftColumn, value: Number(match[4]) });
      }
      continue;
    }
    if (rightColumn !== null && rightAlias !== null) {
      // Соединение двух таблиц по столбцу владельца связывает их области.
      links.join(`${leftAlias}.${leftColumn}`, `${rightAlias}.${rightColumn}`);
    }
  }

  // INSERT: значение владельца стоит в списке VALUES, а не в условии.
  for (const ref of tenantRefs) {
    const columns = tenantColumns(ref.table)!;
    for (const binding of insertBindings(text, ref.table, columns)) {
      anchor(ref.alias, binding);
    }
  }

  const uses: TenantTableUse[] = [];
  const bindings: TenantBinding[] = [];
  for (const ref of tenantRefs) {
    const columns = tenantColumns(ref.table)!;
    const own: TenantBinding[] = [];
    for (const column of columns) {
      const key = `${ref.alias}.${column}`;
      own.push(...(anchored.get(key) ?? []));
      // Столбец, связанный соединением с уже ограниченным столбцом.
      for (const [otherKey, list] of anchored) {
        if (otherKey === key) continue;
        if (links.same(key, otherKey)) own.push(...list);
      }
    }
    const scoped = own.length > 0;
    uses.push({ table: ref.table, alias: ref.alias, scoped, bindings: own });
    bindings.push(...own);
  }

  return {
    uses,
    unscoped: uses.filter((use) => !use.scoped).map((use) => use.table),
    bindings,
  };
}

/** Столбец адресует Telegram-идентификатор, а не внутренний `users.id`. */
export function isTelegramColumn(column: string): boolean {
  return TELEGRAM_COLUMNS.has(column);
}
