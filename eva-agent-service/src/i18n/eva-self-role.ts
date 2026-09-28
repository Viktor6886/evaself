/**
 * Роль, которой Ева называет себя: «я твоя помощница», а не «твой помощник».
 *
 * `feminizeSelfReference` правит сказуемое о себе, но в «Я — твой
 * помощник» глагола нет, и мужской род проходил мимо правки. Здесь та же
 * осторожность: закрытый список ролей, только после «я» (или первого лица
 * перед «быть»), только группа целиком — определение, прилагательные и
 * сама роль. Группа, которая не дочитывается до роли из списка, не
 * правится вовсе: «я твой психолог» и «я твой ассистент» остаются как
 * есть — у этих слов нет естественной женской формы.
 */

export interface RoleEdit { from: number; to: number; text: string; was: string }

/** Роль в именительном падеже: «я твой помощник». */
const NOMINATIVE = new Map<string, string>([
  ["помощник", "помощница"],
  ["собеседник", "собеседница"],
  ["друг", "подруга"],
  ["компаньон", "компаньонка"],
  ["спутник", "спутница"],
  ["союзник", "союзница"],
  ["наставник", "наставница"],
  ["проводник", "проводница"],
  ["слушатель", "слушательница"],
  ["советчик", "советчица"],
  ["напарник", "напарница"],
]);

/** Та же роль в творительном: «буду твоим собеседником». */
const INSTRUMENTAL = new Map<string, string>([
  ["помощником", "помощницей"],
  ["собеседником", "собеседницей"],
  ["другом", "подругой"],
  ["компаньоном", "компаньонкой"],
  ["спутником", "спутницей"],
  ["союзником", "союзницей"],
  ["наставником", "наставницей"],
  ["проводником", "проводницей"],
  ["слушателем", "слушательницей"],
  ["советчиком", "советчицей"],
  ["напарником", "напарницей"],
]);

const OWNERS_NOMINATIVE = new Map([["твой", "твоя"], ["ваш", "ваша"], ["свой", "своя"]]);
const OWNERS_INSTRUMENTAL = new Map([["твоим", "твоей"], ["вашим", "вашей"], ["своим", "своей"]]);

/** Приложение между «я» и ролью: «я — Ева, твоя подруга», «я ИИ, твоя помощница». */
const APPOSITIONS = new Set(["ева", "ии", "ai", "бот"]);

/** Слова между «я» и ролью, при которых роль остаётся её: «я не просто помощница». */
const ROLE_FILLERS = new Set([
  "не", "просто", "лишь", "только", "всего", "тоже", "также", "всегда", "именно",
  "всё", "ещё", "еще", "же", "ведь", "здесь", "тут", "тебе", "вам", "как",
  "по-прежнему", "скорее", "конечно",
]);

/** Слова между связкой и ролью: «быть для тебя собеседницей». */
const LINK_FILLERS = new Set([
  "для", "тебя", "вас", "тебе", "вам", "всегда", "просто", "и", "дальше",
  "по-прежнему", "не", "только", "лишь", "здесь", "рядом", "снова", "опять",
]);

/** Первое лицо без «я»: «буду», «стану» говорят только о себе. */
const FIRST_PERSON_LINKS = new Set(["буду", "стану", "останусь", "остаюсь", "являюсь"]);

/** Связки, которым первое лицо нужно найти слева: «я рада быть…». */
const INFINITIVE_LINKS = new Set(["быть", "стать", "оставаться", "побыть"]);

/** Кто может говорить перед «быть»: только сама Ева. */
const SELF_MARKERS = new Set(["я", "мне", "буду", "хочу", "могу", "постараюсь", "стану"]);

/** Чужое подлежащее между первым лицом и связкой: «я хочу, чтобы он был…». */
const OTHER_SUBJECTS = new Set(["ты", "вы", "он", "она", "они", "мы", "оно"]);

/** Причастие: «созданный», «работающий». Обычное прилагательное — «личный» — сюда не входит. */
const PARTICIPLE = /^[а-яё]+(?:нн|вш|ющ|ащ|ящ|ущ)(?:ый|ий)$/u;

/** Слово с разделителем перед ним; дефис внутри слова — часть слова. */
const TOKEN = /([\s,—–]*(?:\s-\s)?[\s,—–]*)([A-Za-zА-ЯЁа-яё]+(?:-[A-Za-zА-ЯЁа-яё]+)*)/uy;

const SELF = /(?<![\p{L}\p{N}-])я(?![\p{L}\p{N}-])/giu;
const LINK = /(?<![\p{L}\p{N}-])(буду|стану|останусь|остаюсь|являюсь|быть|стать|оставаться|побыть)(?![\p{L}\p{N}-])/giu;

interface Token { at: number; word: string; lower: string; separator: string; end: number }

function tokenAt(text: string, cursor: number): Token | null {
  TOKEN.lastIndex = cursor;
  const match = TOKEN.exec(text);
  if (!match) return null;
  const word = match[2] ?? "";
  const end = match.index + match[0].length;
  return { at: end - word.length, word, lower: word.toLocaleLowerCase("ru"), separator: match[1] ?? "", end };
}

/** Регистр оригинала: «Твой» → «Твоя», «ТВОЙ» → «ТВОЯ». */
function keepCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toLocaleUpperCase("ru")) {
    return replacement.toLocaleUpperCase("ru");
  }
  const first = original[0] ?? "";
  return first !== first.toLocaleLowerCase("ru")
    ? replacement[0]!.toLocaleUpperCase("ru") + replacement.slice(1)
    : replacement;
}

/** Полное прилагательное мужского рода — в женский: «личный» → «личная». */
function feminineAdjective(lower: string, instrumental: boolean): string | null {
  if (lower.length < 4 || !/^[а-яё]+$/u.test(lower)) return null;
  if (instrumental) {
    if (lower.endsWith("ым")) return lower.slice(0, -2) + "ой";
    if (/[гкх]им$/u.test(lower)) return lower.slice(0, -2) + "ой";
    if (/[жшщчн]им$/u.test(lower)) return lower.slice(0, -2) + "ей";
    return null;
  }
  if (lower.endsWith("ый") || lower.endsWith("ой")) return lower.slice(0, -2) + "ая";
  if (/[гкхжшщч]ий$/u.test(lower)) return lower.slice(0, -2) + "ая";
  if (lower.endsWith("ний")) return lower.slice(0, -2) + "яя";
  return null;
}

/** Роль с приставкой «ИИ-»: правится только основа. */
function feminineRole(word: string, instrumental: boolean): string | null {
  const hyphen = word.lastIndexOf("-");
  const prefix = hyphen >= 0 ? word.slice(0, hyphen + 1) : "";
  const base = word.slice(prefix.length);
  const table = instrumental ? INSTRUMENTAL : NOMINATIVE;
  const fixed = table.get(base.toLocaleLowerCase("ru"));
  return fixed ? prefix + keepCase(base, fixed) : null;
}

/**
 * Группа роли с `cursor`: определение, до трёх прилагательных, роль и
 * однородные роли через «и» или запятую. Возвращает правки и конец группы
 * или null, если первая группа не дочитана до роли из списка.
 */
function roleGroup(
  text: string,
  cursor: number,
  instrumental: boolean,
): { edits: RoleEdit[]; end: number } | null {
  const edits: RoleEdit[] = [];
  let groups = 0;
  let position = cursor;
  for (;;) {
    const pending: RoleEdit[] = [];
    let token = tokenAt(text, position);
    if (groups > 0) {
      // Следующая роль — только через запятую или «и»: «помощница и подруга».
      if (!token) break;
      if (token.lower === "и") token = tokenAt(text, token.end);
      else if (!token.separator.includes(",")) break;
      if (!token) break;
    }
    const owners = instrumental ? OWNERS_INSTRUMENTAL : OWNERS_NOMINATIVE;
    const owner = token ? owners.get(token.lower) : undefined;
    if (token && owner) {
      pending.push({ from: token.at, to: token.at + token.word.length, text: keepCase(token.word, owner), was: token.word });
      token = tokenAt(text, token.end);
    }
    for (let count = 0; token && count < 3; count += 1) {
      if (feminineRole(token.word, instrumental)) break;
      const adjective = feminineAdjective(token.lower, instrumental);
      if (!adjective) break;
      pending.push({ from: token.at, to: token.at + token.word.length, text: keepCase(token.word, adjective), was: token.word });
      token = tokenAt(text, token.end);
    }
    const role = token ? feminineRole(token.word, instrumental) : null;
    if (!token || !role) break;
    // «Я, друг мой, …» — обращение к человеку, а не роль Евы.
    const after = tokenAt(text, token.end);
    if (after && !after.separator.trim() && /^мо[йя]$/u.test(after.lower)) break;
    pending.push({ from: token.at, to: token.at + token.word.length, text: role, was: token.word });
    edits.push(...pending);
    position = token.end;
    groups += 1;
  }
  return groups > 0 ? { edits, end: position } : null;
}

/**
 * Правки роли Евы в тексте `view` (разметка уже заменена пробелами).
 * `guarded` отсекает цитаты и код, `handedOver` — фразу, предложенную
 * человеку: «скажи: я твой друг» — его слова, не её.
 */
export function selfRoleEdits(
  view: string,
  guarded: (index: number) => boolean,
  handedOver: (index: number) => boolean,
): RoleEdit[] {
  const edits: RoleEdit[] = [];
  const accept = (group: { edits: RoleEdit[] } | null) => {
    if (!group || group.edits.some((edit) => guarded(edit.from))) return;
    edits.push(...group.edits.filter((edit) => edit.text !== edit.was));
  };

  for (const match of view.matchAll(SELF)) {
    const start = match.index ?? 0;
    if (guarded(start) || handedOver(start)) continue;
    let cursor = start + match[0].length;
    for (let step = 0; step < 6; step += 1) {
      const token = tokenAt(view, cursor);
      if (!token) break;
      if (ROLE_FILLERS.has(token.lower) || APPOSITIONS.has(token.lower)) {
        cursor = token.end;
        continue;
      }
      break;
    }
    const group = roleGroup(view, cursor, false);
    accept(group);
    // «Я твоя помощница, созданная…»: причастный оборот за ролью — о ней.
    const next = group ? tokenAt(view, group.end) : null;
    const participle = next && next.separator.includes(",") && PARTICIPLE.test(next.lower)
      ? feminineAdjective(next.lower, false)
      : null;
    if (next && participle) {
      accept({ edits: [{ from: next.at, to: next.at + next.word.length, text: keepCase(next.word, participle), was: next.word }] });
    }
  }

  for (const match of view.matchAll(LINK)) {
    const start = match.index ?? 0;
    const link = (match[1] ?? "").toLocaleLowerCase("ru");
    if (guarded(start) || handedOver(start)) continue;
    if (INFINITIVE_LINKS.has(link)) {
      // Первое лицо ищется в той же части предложения: за запятой или
      // «что» подлежащее уже может быть другим.
      const clause = view.slice(0, start).split(/[.!?…\n,;:—–(]/u).at(-1) ?? "";
      const words = clause.toLocaleLowerCase("ru").split(/[^а-яё-]+/u).filter(Boolean);
      const self = words.findLastIndex((word) => SELF_MARKERS.has(word));
      if (self < 0 || words.slice(self).some((word) => OTHER_SUBJECTS.has(word))) continue;
    } else if (!FIRST_PERSON_LINKS.has(link)) {
      continue;
    }
    let cursor = start + match[0].length;
    for (let step = 0; step < 4; step += 1) {
      const token = tokenAt(view, cursor);
      if (!token || !LINK_FILLERS.has(token.lower)) break;
      cursor = token.end;
    }
    accept(roleGroup(view, cursor, true));
  }
  return edits;
}
