/**
 * Женский род Евы — детерминированной правкой, а не только правилом.
 *
 * Правило записано трижды: в персоне, в системном промпте и в директиве
 * резервному провайдеру. Модель всё равно срывается на коротких
 * служебных репликах — «понял», «готов», «сделал», — и человек видит,
 * что собеседница путает собственный род. Четвёртая формулировка того же
 * правила эту вероятность не обнуляет; известные случаи исправляет
 * правка на выходе. Это осторожная эвристика, а не полный разбор языка.
 *
 * Это не второй когнитивный контур. Здесь не выбирается, что сказать, и
 * не переписывается смысл: приводится согласование по роду там, где
 * подлежащее — сама Ева. Та же граница, что у `formatEvaReply` и
 * `speechTextFromReply`, только про грамматику, а не про разметку.
 *
 * Осторожность важнее полноты. Пропущенная правка — это сегодняшнее
 * положение дел; лишняя правка — новая порча текста. Поэтому:
 *
 *  - без «я» перед словом правится только закрытый список коротких
 *    реплик: «Поняла.», «Готова.» — там подлежащее не нужно и не бывает
 *    чужим;
 *  - цитаты и код не трогаются вовсе: там могут быть слова человека;
 *  - фраза, предложенная человеку («скажи ему: я справился»), не его
 *    род менять — не трогается;
 *  - слово, для которого нет надёжного правила, остаётся как есть.
 */

import {
  IRREGULAR,
  REVERSE_IRREGULAR,
  SUFFIXES,
  FILLERS,
  MAX_FILLERS,
  MAX_SELF_FILLERS,
  FIRST_PERSON,
  PREDICATE_MODIFIERS,
  OPENERS,
  NOUNS_LIKE_PAST,
  INVERTED_SUBJECT_VERBS,
  ANIMATE_SUBJECTS,
  describesOther,
  DETERMINERS,
  COPULAS,
  POSSESSIVE_FILLERS,
  SUBJECT_PRONOUNS,
  LEADING_ADVERBS,
  LEADING_INTERJECTIONS,
  CLAUSE_BREAKERS,
  HANDOVER,
  REPORTED_SPEECH,
  USER_FILLERS,
  USER_QUESTION_OPENERS,
} from "./eva-gender-lexicon.js";
import { selfRoleEdits } from "./eva-self-role.js";

/** Каноническое предпочтение согласования с пользователем. */
export type UserGrammaticalGender = "masculine" | "feminine";

/**
 * Явный выбор пользователя, который можно сохранить без догадки модели.
 *
 * Имя, фотография и пол третьих лиц намеренно ничего не значат. Берутся
 * только слова от первого лица или прямая просьба о грамматическом роде.
 */
export function explicitUserGrammaticalGender(
  input: string,
): UserGrammaticalGender | null {
  const text = input.trim().toLocaleLowerCase("ru");
  const masculine = [
    /(?:^|[.!?]\s+)я\s+(?!не\b)(?:мужчина|парень)(?=$|[\s,.!?;:])/u,
    /(?:^|[.!?]\s+)(?:обращайся|говори|пиши)\s+(?:со\s+мной\s+|ко\s+мне\s+)?(?:в|используя)\s+мужск[\p{L}-]*\s+род[\p{L}-]*/u,
    /(?:^|[.!?]\s+)(?:мой|мне\s+подходит)\s+(?:грамматический\s+)?род\s*[—:-]?\s*мужск[\p{L}-]*/u,
    /(?:^|[.!?]\s+)(?:мой\s+)?пол\s*[—:-]?\s*мужск[\p{L}-]*/u,
    /(?:^|[.!?]\s+)обращайся\s+ко\s+мне\s+как\s+к\s+мужчине/u,
  ].some((pattern) => pattern.test(text));
  const feminine = [
    /(?:^|[.!?]\s+)я\s+(?!не\b)(?:женщина|девушка)(?=$|[\s,.!?;:])/u,
    /(?:^|[.!?]\s+)(?:обращайся|говори|пиши)\s+(?:со\s+мной\s+|ко\s+мне\s+)?(?:в|используя)\s+женск[\p{L}-]*\s+род[\p{L}-]*/u,
    /(?:^|[.!?]\s+)(?:мой|мне\s+подходит)\s+(?:грамматический\s+)?род\s*[—:-]?\s*женск[\p{L}-]*/u,
    /(?:^|[.!?]\s+)(?:мой\s+)?пол\s*[—:-]?\s*женск[\p{L}-]*/u,
    /(?:^|[.!?]\s+)обращайся\s+ко\s+мне\s+как\s+к\s+женщине/u,
  ].some((pattern) => pattern.test(text));
  // Противоречивое сообщение не должно молча менять профиль.
  if (masculine === feminine) return null;
  return masculine ? "masculine" : "feminine";
}

/**
 * Глагол прошедшего времени мужского рода без «я» в начале фразы.
 *
 * В русском опущенное подлежащее при таком глаголе — первое лицо:
 * «Разобрал запись», «Уточнил детали». Закрытого списка здесь мало —
 * модель берёт любой глагол, и каждый новый оставался мужским. Поэтому
 * правило общее, а осторожность — в исключениях: не существительное,
 * не глагол с обратным порядком слов, не возвратная форма (у «Начался
 * семестр» подлежащее всегда чужое) и не фраза, где за глаголом сразу
 * стоит имя или местоимение-подлежащее.
 */
export function isSelfPastPredicate(word: string, next: string): boolean {
  const lower = word.toLocaleLowerCase("ru");
  if (next) {
    // «…, получил ли он письмо» — косвенный вопрос о другом человеке.
    if (next.toLocaleLowerCase("ru") === "ли") return false;
    // «Позвонил Иван», «Сделал он» — подлежащее стоит после глагола.
    if (next[0] !== next[0]!.toLocaleLowerCase("ru")) return false;
    if (SUBJECT_PRONOUNS.has(next.toLocaleLowerCase("ru"))) return false;
    // «Стамбул встретил», «Кабул остался»: если сразу за словом стоит
    // глагол прошедшего времени, само слово — подлежащее, а не глагол.
    // Словарём топонимы и имена на «-ул», «-ал» не перечислить.
    // Признак — только мужская форма: «детали», «школа» оканчиваются на
    // «-ли», «-ла», но глаголами не являются.
    const nextLower = next.toLocaleLowerCase("ru");
    if (/(?:[аяиеуы]л|ёл|лся)$/u.test(nextLower) && nextLower.length >= 4
      && !NOUNS_LIKE_PAST.has(nextLower) && !OPENERS.has(nextLower)) {
      return false;
    }
  }
  // «Был сбой», «Да, был дождь»: бытийное «был» с подлежащим за ним —
  // не Ева о себе. О себе — только перед её сказуемым: «Был рад помочь»,
  // «Был бы рад».
  if (lower === "был") {
    return /^(?:бы|не|очень|так|уже|тоже)$/iu.test(next) || IRREGULAR.has(next.toLocaleLowerCase("ru"));
  }
  if (OPENERS.has(lower)) return true;
  if (lower.length < 5 || !CYRILLIC_WORD.test(word)) return false;
  if (!/[аяиеуы]л$/u.test(lower)) return false;
  return !NOUNS_LIKE_PAST.has(lower) && !INVERTED_SUBJECT_VERBS.has(lower);
}

/**
 * Продолжение ряда, который начала сама Ева: «я устала и проголодалась».
 *
 * Возвратная форма в начале фразы общим правилом не правится — у
 * «Начался семестр» подлежащее чужое. Но после «и» в ряду Евы подлежащее
 * уже известно, и «проголодался» — её сказуемое.
 */
function isSelfContinuation(word: string, next: string): boolean {
  const lower = word.toLocaleLowerCase("ru");
  if (describesOther(lower) || DETERMINERS.has(lower)) return false;
  // «…, и пришёл он»: подлежащее за сказуемым — чужое, даже когда
  // форма нерегулярная и в общем правиле не проверяется.
  if (next && (next.toLocaleLowerCase("ru") === "ли"
    || SUBJECT_PRONOUNS.has(next.toLocaleLowerCase("ru"))
    || next[0] !== next[0]!.toLocaleLowerCase("ru"))) return false;
  if (IRREGULAR.has(lower) || isSelfPastPredicate(word, next)) return true;
  return /лся$/u.test(lower) && isSelfPastPredicate(word.slice(0, -2), next);
}

/**
 * Сказуемое Евы, уже стоящее в женском роде: «Поняла», «я рада».
 *
 * Править в нём нечего, но ряд за ним — её: в «Поняла тебя и записал»
 * мужским оставался второй глагол, потому что продолжение искалось
 * только после исправленного слова.
 */
function isFeminineSelf(word: string, next: string): boolean {
  const lower = word.toLocaleLowerCase("ru");
  if (!/(?:ла|лась)$/u.test(lower) && !REVERSE_IRREGULAR.has(lower)) return false;
  // «Была весна, и запел скворец»: безличная связка — не Ева о себе.
  // Опорой она становится, только когда за ней стоит её сказуемое:
  // «Была рада помочь».
  if (lower === "была") return REVERSE_IRREGULAR.has(next.toLocaleLowerCase("ru"));
  const masculine = masculineForm(word);
  if (!masculine) return false;
  return OPENERS.has(masculine.toLocaleLowerCase("ru")) || isSelfPastPredicate(masculine, next);
}

const CLAUSE_TOKEN = /([,—–:;(])|([а-яёА-ЯЁ-]+)/gu;

const CYRILLIC_WORD = /^[а-яёА-ЯЁ-]+$/u;

/** Женская форма слова — или null, если надёжного правила нет. */
export function feminineForm(word: string): string | null {
  const lower = word.toLocaleLowerCase("ru");
  const irregular = IRREGULAR.get(lower);
  if (irregular) return matchCase(word, irregular);
  if (lower.length < 3 || !CYRILLIC_WORD.test(word)) return null;
  for (const [from, to] of SUFFIXES) {
    if (!lower.endsWith(from)) continue;
    return matchCase(word, lower.slice(0, lower.length - from.length) + to);
  }
  return null;
}

/** Заглавная буква оригинала переносится на исправленную форму. */
function matchCase(original: string, replacement: string): string {
  if (original === original.toLocaleUpperCase("ru")) return replacement.toLocaleUpperCase("ru");
  const first = original[0] ?? "";
  return first !== first.toLocaleLowerCase("ru")
    ? replacement[0]!.toLocaleUpperCase("ru") + replacement.slice(1)
    : replacement;
}

export interface GenderFix {
  /** Текст, в котором Ева говорит о себе в женском роде. */
  text: string;
  /** Что исправлено: для метрики и журнала, без самого текста. */
  corrections: string[];
}

/** Мужская форма слова — или null, если правило небезопасно. */
export function masculineForm(word: string): string | null {
  const lower = word.toLocaleLowerCase("ru");
  const irregular = REVERSE_IRREGULAR.get(lower);
  if (irregular) return matchCase(word, irregular);
  if (lower.length < 4 || !CYRILLIC_WORD.test(word)) return null;
  if (lower.endsWith("лась")) {
    return matchCase(word, lower.slice(0, -4) + "лся");
  }
  // Вне синтаксически защищённого обращения это правило применять
  // нельзя: «школа» тоже оканчивается на -ла.
  if (lower.endsWith("ла")) {
    return matchCase(word, lower.slice(0, -1));
  }
  return null;
}

/*
 * Участки, которые пропускаются целиком.
 *
 * Внутри кавычек и кода могут стоять слова человека — там род не наш.
 * Блоки кода идут первыми: внутри них кавычки не кавычки.
 */
// Открытые цитаты и код защищены и до прихода закрывающего чанка.
const SKIPPED = /(?<fence>`{3,}|~{3,})[\s\S]*?(?:\k<fence>|(?![\s\S]))|(?<ticks>`+)[^\n]*?(?:\k<ticks>|(?=\n)|$)|«[^»]*(?:»|(?![\s\S]))|"[^"\n]*(?:"|(?=\n)|$)|“[^”]*(?:”|(?![\s\S]))|^[ \t]*>[^\n]*|\]\([^\n)]*\)|https?:\/\/[^\s<>]+/gmu;

/**
 * Разметка не является границей сказуемого: «я **готов**».
 * Смещения сохраняются, а правки применяются к оригиналу, включая Markdown.
 * Внутренние подчёркивания идентификаторов не считаются оформлением.
 */
function grammarView(text: string): string {
  return text
    .replace(/(?<![\p{L}\p{N}*_~])[*_~]+|[*_~]+(?![\p{L}\p{N}*_~])/gu, (mark) => " ".repeat(mark.length))
    .replace(/^[ \t]*(?:#{1,6}|[-+*]|\d+[.)])[ \t]+/gmu, (mark) => " ".repeat(mark.length));
}

/*
 * Отдельно стоящее «я».
 *
 * Границы слова заданы явно: `\b` в JavaScript знает только латиницу,
 * и `\bя\b` не совпадает ни с одним русским «я» — молча, без ошибки.
 */
const STANDALONE_I = /(?<![\p{L}\p{N}-])я(?![\p{L}\p{N}-])/giu;

/** Слово, возможно отделённое пробелами и запятыми. */
const NEXT_WORD = /[\s,—-]*([а-яёА-ЯЁ-]+)/yu;

/*
 * Короткая реплика, открывающая предложение: «Поняла.», «Поняла тебя.»
 *
 * Знака препинания сразу за словом больше не требуется: «Понял тебя» —
 * та же реплика о себе, и без этого она оставалась мужской. Вместо
 * этого отбрасывается предложение-вопрос: «Понял?» и «Готов ли ты?»
 * обращены к человеку, и род в них не её.
 */
const OPENER = /(^[ \t]*|[.!?\n]\s*)([А-ЯЁа-яё]+)/gu;

/** Продолжение однородного ряда: «, записала», « и решила». */
const SERIES = /[\s,]*(?:и[\s]+)?([а-яёА-ЯЁ-]+)/yu;

/** Чем кончается предложение, внутри которого стоит слово. */
function sentenceEnd(text: string, from: number): string {
  const rest = text.slice(from);
  const stop = /[.!?…\n]/u.exec(rest);
  return stop?.[0] ?? "";
}

interface Edit { from: number; to: number; text: string; was: string }

/**
 * Привести речь Евы о себе к женскому роду.
 *
 * Возвращает исправленный текст и список правок в порядке появления.
 * Пустой список означает, что трогать было нечего, — и тогда
 * возвращается ровно та же строка.
 */
export function feminizeSelfReference(input: string): GenderFix {
  const original = input;
  const spans = protectedSpans(input);
  input = grammarView(input);
  const guarded = (index: number) => spans.some(([from, to]) => index >= from && index < to);
  const handedOver = (index: number) => {
    const before = input.slice(Math.max(0, index - 48), index);
    return HANDOVER.test(before) || REPORTED_SPEECH.test(before);
  };
  // Правки собираются по исходному тексту и применяются одной сборкой:
  // менять строку на ходу значит сдвигать смещения следующих совпадений.
  const edits: Edit[] = [];
  const add = (from: number, word: string, complement = false): boolean => {
    if (guarded(from)) return false;
    // «Канал», «файл» — существительные на «-л»: их род не Евы.
    const lowerWord = word.toLocaleLowerCase("ru");
    if (NOUNS_LIKE_PAST.has(lowerWord) || /йл$/u.test(lowerWord)) return false;
    if (describesOther(lowerWord)) return false;
    if (DETERMINERS.has(lowerWord) && !complement) return false;
    const fixed = feminineForm(word);
    if (!fixed || fixed === word) return false;
    if (edits.some((edit) => edit.from === from)) return false;
    edits.push({ from, to: from + word.length, text: fixed, was: word });
    return true;
  };

  /** Однородные сказуемые того же подлежащего: «подумала и решила». */
  const continueSeries = (from: number): void => {
    let cursor = from;
    // Сказуемое, за которым стоит следующее слово: от него зависит,
    // согласуется ли слово вплотную за ним.
    let last = (/([А-ЯЁа-яё-]+)\s*$/u.exec(input.slice(0, from))?.[1] ?? "").toLocaleLowerCase("ru");
    for (;;) {
      SERIES.lastIndex = cursor;
      const next = SERIES.exec(input);
      const following = next?.[1] ?? "";
      if (!next || !following) break;
      // «Был бы рад», «был не прав»: частица между связкой и
      // сказуемым подлежащего не меняет — сказуемое за ней то же.
      // Только внутри той же группы сказуемого: за запятой «не» открывает
      // косвенный вопрос — «я подумала, не пришёл ли поезд».
      if (PREDICATE_MODIFIERS.has(following.toLocaleLowerCase("ru"))
        && /^\s+$/u.test(next[0].slice(0, next[0].length - following.length))) {
        cursor = next.index + next[0].length;
        continue;
      }
      const at = next.index + next[0].length - following.length;
      // Вплотную за сказуемым правится только нерегулярная форма —
      // «был рад», «был вынужден». Любое другое слово там —
      // дополнение: «проверила канал», «открыла файл».
      const joined = /[,и]/u.test(next[0].slice(0, next[0].length - following.length));
      const lower = following.toLocaleLowerCase("ru");
      const afterWord = /^\s*([А-ЯЁа-яё-]+)/u.exec(input.slice(at + following.length))?.[1] ?? "";
      const feminine = isFeminineSelf(following, afterWord);
      // Вплотную за связкой — её именная часть: «была рада», «была одна».
      // За другим глаголом — только «сам» и «один» в конце группы:
      // «сделала сама.», но не «увидела сам процесс».
      const closing = /^\s*(?:[.!?…,;:)]|$)/u.test(input.slice(at + following.length));
      const complement = !joined && IRREGULAR.has(lower)
        && (COPULAS.has(last) || (DETERMINERS.has(lower) && closing));
      const allowed = complement || (joined && isSelfContinuation(following, afterWord));
      if ((!allowed && !feminine) || guarded(at)) break;
      add(at, following, complement);
      last = lower;
      cursor = next.index + next[0].length;
    }
  };

  /**
   * Однородные сказуемые дальше по предложению: «Уточнила детали и
   * отправила список». Каждое следующее сказуемое стоит после «и» или
   * запятой; слова между ними — дополнения, их род не наш. Проход
   * обрывается, как только начинается другая часть предложения — «а он»,
   * «что», имя, тире, — или после союза стоит не сказуемое: дальше
   * подлежащее уже может быть чужим, и угадывать его нельзя.
   */
  const continueClause = (from: number, conjunctionOnly = false): void => {
    const stop = /[.!?…\n]/u.exec(input.slice(from));
    const end = stop ? from + stop.index : input.length;
    const segment = input.slice(from, end);
    const tokens = [...segment.matchAll(CLAUSE_TOKEN)];
    let joined = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      const punctuation = token[1];
      if (punctuation) {
        if (punctuation !== ",") return;
        // После «знаю/вижу» запятая часто начинает косвенный вопрос:
        // «я знаю, готов результат или нет». Нужен явный союз.
        if (conjunctionOnly && !/^\s*(?:и|но)\s/u.test(segment.slice((token.index ?? 0) + 1))) return;
        joined = true;
        continue;
      }
      const word = token[2] ?? "";
      const lower = word.toLocaleLowerCase("ru");
      if (lower === "и" || lower === "но") {
        joined = true;
        continue;
      }
      if (joined && PREDICATE_MODIFIERS.has(lower)) continue;
      if (CLAUSE_BREAKERS.has(lower) || SUBJECT_PRONOUNS.has(lower)) return;
      if (!joined) continue;
      const next = tokens[index + 1]?.[2] ?? "";
      const at = from + (token.index ?? 0);
      if (guarded(at)) return;
      // После настоящего времени однородный ряд может состоять из
      // дополнений: «вижу план и хороший результат», «знаю правило и
      // один пример». Полные прилагательные и определители не правим.
      if (conjunctionOnly && /(?:ый|ий|ой)$|^(?:один|сам|мужчина|парень)$/u.test(lower)) return;
      const lowerIsSelf = isSelfContinuation(word, next) || isFeminineSelf(word, next);
      if (!lowerIsSelf) return;
      // «…, и объяснил её врач»: подлежащее после дополнения.
      const rest = segment.slice((token.index ?? 0) + word.length).split(/[,;:—–]/u)[0] ?? "";
      if (rest.split(/\s+/u).some((item) => ANIMATE_SUBJECTS.has(item.toLocaleLowerCase("ru")))) return;
      add(at, word);
      joined = false;
    }
  };

  for (const match of input.matchAll(STANDALONE_I)) {
    const start = match.index ?? 0;
    if (guarded(start) || handedOver(start)) continue;
    // Ищем только через известные вводные; неизвестное слово, в том
    // числе чужое подлежащее, останавливает разбор.
    let cursor = start + match[0].length;
    let possessive = false;
    let previous = "";
    for (let step = 0; step <= MAX_SELF_FILLERS; step += 1) {
      NEXT_WORD.lastIndex = cursor;
      const next = NEXT_WORD.exec(input);
      if (!next) break;
      const word = next[1] ?? "";
      const wordAt = next.index + next[0].length - word.length;
      if (guarded(wordAt)) break;
      const lowerWord = word.toLocaleLowerCase("ru");
      // «Я вот что подумал»: «что» после «вот» — не придаточное.
      const filler = FILLERS.has(lowerWord) || (lowerWord === "что" && previous === "вот");
      if (step < MAX_SELF_FILLERS && filler) {
        possessive = POSSESSIVE_FILLERS.has(lowerWord);
        previous = lowerWord;
        cursor = next.index + next[0].length;
        continue;
      }
      // «Я сама не уверена», «я одна не справлюсь»: определитель при «я»
      // согласуется с Евой, а сказуемое стоит дальше.
      if (step < MAX_SELF_FILLERS && (DETERMINERS.has(lowerWord) || lowerWord === "сама" || lowerWord === "одна")) {
        add(wordAt, word, true);
        previous = lowerWord;
        cursor = next.index + next[0].length;
        continue;
      }
      // «Я его канал проверил»: «его» здесь притяжательное, и следующее
      // слово — существительное. Правится только форма, похожая на
      // сказуемое.
      const afterWord = /^\s*([А-ЯЁа-яё-]+)/u.exec(input.slice(wordAt + word.length))?.[1] ?? "";
      if (possessive && !IRREGULAR.has(word.toLocaleLowerCase("ru"))
        && !isSelfPastPredicate(word, afterWord)) break;
      const firstPerson = FIRST_PERSON.has(word.toLocaleLowerCase("ru"));
      if (!add(wordAt, word) && !isFeminineSelf(word, afterWord) && !firstPerson) break;
      continueClause(wordAt + word.length, firstPerson);
      // «Я подумала и решил» — половина исправленного хуже, чем ничего:
      // в одном предложении оказывалось два рода. Ряд продолжается,
      // пока следующее слово само поддаётся правилу; чужое подлежащее
      // его обрывает — «я спросил, он ответил» доходит до «он», и
      // править там нечего.
      // «Я вижу хороший результат» — дополнение, не речь о себе.
      // Непосредственное согласование нужно лишь связке «буду рада».
      if (!firstPerson || word.toLocaleLowerCase("ru") === "буду") {
        continueSeries(wordAt + word.length);
      }
      break;
    }
  }

  for (const match of input.matchAll(OPENER)) {
    const start = match.index ?? 0;
    const [, lead = "", opening = ""] = match;
    let word = opening;
    let wordAt = start + lead.length;
    if (guarded(wordAt) || handedOver(wordAt)) continue;
    // «Да, уже проверил», «Пока не уверен»: несколько вводных подряд.
    for (let step = 0; step < MAX_SELF_FILLERS; step += 1) {
      const lower = word.toLocaleLowerCase("ru");
      const rest = input.slice(wordAt + word.length);
      const shifted = LEADING_INTERJECTIONS.has(lower) && /^\s*,/u.test(rest)
        ? /^(\s*,\s*)([А-ЯЁа-яё]+)/u.exec(rest)
        : (LEADING_ADVERBS.has(lower) || PREDICATE_MODIFIERS.has(lower))
          ? /^(\s+)([А-ЯЁа-яё]+)/u.exec(rest)
          : null;
      if (!shifted) break;
      wordAt += word.length + shifted[1]!.length;
      word = shifted[2]!;
    }
    if (guarded(wordAt)) continue;
    // Заголовок или определение («Сигнал — это…», «Итог:») — не реплика.
    const after = input.slice(wordAt + word.length);
    if (/^\s*[—:–-]/u.test(after)) continue;
    // Подлежащее после глагола стоит без запятой: «Сделал он». После
    // запятой начинается другое: «Проверила, всё ли работает».
    const following = /^\s*([А-ЯЁа-яё-]+)/u.exec(after)?.[1] ?? "";
    const feminine = isFeminineSelf(word, following);
    if (!feminine && !isSelfPastPredicate(word, following)) continue;
    // «Получил ответ пользователь»: подлежащее после дополнения.
    const clause = after.split(/[,.!?…\n;:—–]/u)[0] ?? "";
    if (clause.split(/\s+/u).some((token) => ANIMATE_SUBJECTS.has(token.toLocaleLowerCase("ru")))) {
      continue;
    }
    // Вопрос обращён к человеку: «Понял?», «Готов ли ты продолжить?».
    // Род в нём не её, и трогать его нельзя.
    if (sentenceEnd(input, wordAt) === "?") continue;
    if (!add(wordAt, word) && !feminine) continue;
    continueClause(wordAt + word.length);
    continueSeries(wordAt + word.length);
  }

  // «Я — твой помощник»: роль, которой Ева себя называет, без глагола.
  for (const edit of selfRoleEdits(input, guarded, handedOver)) {
    if (!edits.some((other) => other.from < edit.to && edit.from < other.to)) edits.push(edit);
  }

  if (edits.length === 0) return { text: original, corrections: [] };
  edits.sort((left, right) => left.from - right.from);
  let text = "";
  let cursor = 0;
  for (const edit of edits) {
    text += original.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return {
    text: text + original.slice(cursor),
    corrections: edits.map((edit) => pair(edit.was, edit.text)),
  };
}

const STANDALONE_YOU = /(?<![\p{L}\p{N}-])ты(?![\p{L}\p{N}-])/giu;
const BEFORE_YOU = /([а-яёА-ЯЁ-]+)\s+ли\s+ты(?=$|[\s,.!?;:])/giu;
const USER_SERIES = /\s+и\s+([а-яёА-ЯЁ-]+)/yu;
const USER_COMPLEMENT = /\s+([а-яёА-ЯЁ-]+)/yu;

function userForm(
  word: string,
  gender: UserGrammaticalGender,
): string | null {
  return gender === "feminine" ? feminineForm(word) : masculineForm(word);
}

/**
 * Привести только надёжные обращения к пользователю к сохранённому роду.
 *
 * Правятся формы после явного «ты», конструкция «готова ли ты», условное
 * «если устал» и короткий вопрос. Цитаты, код, утверждения о третьих лицах
 * и любые случаи без подтверждённого профиля остаются как есть.
 */
export function alignUserReference(
  input: string,
  gender: UserGrammaticalGender | null,
): GenderFix {
  if (!gender) return { text: input, corrections: [] };
  const spans = protectedSpans(input);
  const guarded = (index: number) => spans.some(([from, to]) => index >= from && index < to);
  const edits: Edit[] = [];
  const add = (from: number, word: string): boolean => {
    if (guarded(from)) return false;
    const fixed = userForm(word, gender);
    if (!fixed || fixed === word || edits.some((edit) => edit.from === from)) return false;
    edits.push({ from, to: from + word.length, text: fixed, was: word });
    return true;
  };

  /** Однородные формы того же «ты»: «устала и была готова». */
  const continueSeries = (from: number): void => {
    let cursor = from;
    for (;;) {
      USER_SERIES.lastIndex = cursor;
      const next = USER_SERIES.exec(input);
      const word = next?.[1] ?? "";
      if (!next || !word) break;
      const at = next.index + next[0].length - word.length;
      if (!add(at, word)) break;
      cursor = next.index + next[0].length;
      if (word.toLocaleLowerCase("ru") === "был" || word.toLocaleLowerCase("ru") === "была") {
        USER_COMPLEMENT.lastIndex = cursor;
        const complement = USER_COMPLEMENT.exec(input);
        const complementWord = complement?.[1] ?? "";
        if (complement && complementWord) {
          const complementAt = complement.index + complement[0].length - complementWord.length;
          if (add(complementAt, complementWord)) {
            cursor = complement.index + complement[0].length;
          }
        }
      }
    }
  };

  for (const match of input.matchAll(STANDALONE_YOU)) {
    const start = match.index ?? 0;
    if (guarded(start)) continue;
    let cursor = start + match[0].length;
    for (let step = 0; step <= MAX_FILLERS; step += 1) {
      NEXT_WORD.lastIndex = cursor;
      const next = NEXT_WORD.exec(input);
      if (!next) break;
      const word = next[1] ?? "";
      const at = next.index + next[0].length - word.length;
      if (step < MAX_FILLERS && USER_FILLERS.has(word.toLocaleLowerCase("ru"))) {
        cursor = next.index + next[0].length;
        continue;
      }
      if (add(at, word)) continueSeries(at + word.length);
      break;
    }
  }

  for (const match of input.matchAll(BEFORE_YOU)) {
    const word = match[1] ?? "";
    add((match.index ?? 0), word);
  }

  // Без «ты» безопасен только вопрос: «Поняла?», «Готова продолжить?».
  // Утверждение «Понял.» по-прежнему относится к самой Еве.
  for (const match of input.matchAll(OPENER)) {
    const start = match.index ?? 0;
    const [, lead = "", word = ""] = match;
    const at = start + lead.length;
    if (guarded(at) || sentenceEnd(input, at) !== "?") continue;
    if (!USER_QUESTION_OPENERS.has(word.toLocaleLowerCase("ru"))) continue;
    add(at, word);
  }

  if (edits.length === 0) return { text: input, corrections: [] };
  edits.sort((left, right) => left.from - right.from);
  let text = "";
  let cursor = 0;
  for (const edit of edits) {
    text += input.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return {
    text: text + input.slice(cursor),
    corrections: edits.map((edit) => pair(edit.was, edit.text)),
  };
}

/** Единый выходной барьер рода: сначала Ева, затем её собеседник. */
export function normalizeReplyGender(
  input: string,
  userGender: UserGrammaticalGender | null,
): GenderFix {
  const self = feminizeSelfReference(input);
  const user = alignUserReference(self.text, userGender);
  return { text: user.text, corrections: [...self.corrections, ...user.corrections] };
}

const pair = (from: string, to: string) =>
  `${from.toLocaleLowerCase("ru")}→${to.toLocaleLowerCase("ru")}`;

/*
 * Сколько раз правка срабатывала.
 *
 * Счётчик — единственный способ узнать, нужна ли эта правка вообще и
 * не растёт ли частота срывов после смены модели. Хранится число, не
 * текст: что именно было в сообщении, метрике знать незачем.
 */
let correctionsTotal = 0;
let repliesTotal = 0;

export function recordGenderFix(corrections: number): void {
  repliesTotal += 1;
  correctionsTotal += corrections;
}

export function genderFixStats(): { replies: number; corrections: number } {
  return { replies: repliesTotal, corrections: correctionsTotal };
}

/** Границы участков, которые правка не трогает. */
function protectedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  SKIPPED.lastIndex = 0;
  for (let match = SKIPPED.exec(text); match !== null; match = SKIPPED.exec(text)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  return spans;
}
