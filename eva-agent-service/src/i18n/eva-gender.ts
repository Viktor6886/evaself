/**
 * Женский род Евы — детерминированной правкой, а не только правилом.
 *
 * Правило записано трижды: в персоне, в системном промпте и в директиве
 * резервному провайдеру. Модель всё равно срывается на коротких
 * служебных репликах — «понял», «готов», «сделал», — и человек видит,
 * что собеседница путает собственный род. Четвёртая формулировка того же
 * правила эту вероятность не обнуляет; обнуляет её правка на выходе.
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

/** Формы, которые не выводятся из окончания: их проще перечислить. */
const IRREGULAR = new Map<string, string>([
  ["рад", "рада"],
  ["готов", "готова"],
  ["уверен", "уверена"],
  ["должен", "должна"],
  ["согласен", "согласна"],
  ["доволен", "довольна"],
  ["спокоен", "спокойна"],
  ["прав", "права"],
  ["неправ", "неправа"],
  ["виноват", "виновата"],
  ["свободен", "свободна"],
  ["занят", "занята"],
  ["счастлив", "счастлива"],
  ["обязан", "обязана"],
  ["намерен", "намерена"],
  ["настроен", "настроена"],
  ["создан", "создана"],
  ["сам", "сама"],
  ["один", "одна"],
  // Прошедшее время, которое из окончания не выводится.
  ["мог", "могла"],
  ["смог", "смогла"],
  ["помог", "помогла"],
  ["лёг", "легла"],
  ["ошибся", "ошиблась"],
  ["увлёкся", "увлеклась"],
  ["сбился", "сбилась"],
  ["привык", "привыкла"],
]);

/**
 * Окончания прошедшего времени.
 *
 * Общего правила для «-г» здесь нет намеренно: «я друг» превратилось бы
 * в «я другла». Слова на «-г» перечислены поимённо выше.
 */
const SUFFIXES: ReadonlyArray<readonly [string, string]> = [
  ["лся", "лась"],
  ["ёл", "ла"],
  ["л", "ла"],
];

/** Слова, которые могут стоять между «я» и сказуемым. */
const FILLERS = new Set([
  "не", "уже", "ещё", "еще", "тоже", "также", "просто", "сейчас", "только",
  "как", "раз", "всё", "все", "точно", "правда", "тебе", "вам", "тебя", "вас",
  "здесь", "там", "это", "бы", "вроде", "честно", "давно", "почти",
  "сразу", "тут", "уж", "же", "ведь", "очень", "именно", "специально",
]);

/**
 * Короткие реплики, которые Ева говорит о себе без подлежащего.
 *
 * Список закрытый: без «я» подлежащее приходится угадывать, а угадывать
 * здесь нельзя. Именно эти формы персона и называет самой частой ошибкой.
 */
const OPENERS = new Set([
  "понял", "принял", "сделал", "готов", "рад", "согласен", "уверен",
  "услышал", "записал", "запомнил", "сохранил", "отправил", "проверил",
  "увидел", "подумал", "заметил", "поправил", "обновил", "добавил",
  "посмотрел", "разобрался", "справился", "нашёл", "нашел", "уловил",
  "понимал", "успел", "закончил", "начал", "прочитал", "учёл", "учел",
]);

/**
 * Слова, после которых идёт реплика, предложенная человеку.
 *
 * «Попробуй сказать: я справился» — его слова, не её. Такой фрагмент
 * правке не подлежит, иначе Ева вложит человеку в рот чужой род.
 */
const HANDOVER =
  /(?:скажи|скажите|сказать|говоришь|говорит|напиши|напишите|написать|ответь|ответьте|фраз\w*|например|звучит|так и скажи)[^.!?\n]{0,24}$/iu;

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

/*
 * Участки, которые пропускаются целиком.
 *
 * Внутри кавычек и кода могут стоять слова человека — там род не наш.
 * Блоки кода идут первыми: внутри них кавычки не кавычки.
 */
const SKIPPED = /```[\s\S]*?```|`[^`\n]*`|«[^»]*»|"[^"\n]*"|“[^”]*”/gu;

/*
 * Отдельно стоящее «я».
 *
 * Границы слова заданы явно: `\b` в JavaScript знает только латиницу,
 * и `\bя\b` не совпадает ни с одним русским «я» — молча, без ошибки.
 */
const STANDALONE_I = /(?<![\p{L}\p{N}-])я(?![\p{L}\p{N}-])/giu;

/** Слово, возможно отделённое пробелами и запятыми. */
const NEXT_WORD = /[\s,—-]*([а-яёА-ЯЁ-]+)/yu;

/** Короткая реплика, открывающая предложение: «Поняла.», «Готова!» */
const OPENER = /(^|[.!?\n]\s*)([А-ЯЁа-яё]+)(?=\s*[.,!…]|\s*$)/gu;

/** Продолжение однородного ряда: «, записала». */
const SERIES = /,\s*([а-яёА-ЯЁ-]+)(?=\s*[.,!…]|\s*$)/yu;

interface Edit { from: number; to: number; text: string; was: string }

/**
 * Привести речь Евы о себе к женскому роду.
 *
 * Возвращает исправленный текст и список правок в порядке появления.
 * Пустой список означает, что трогать было нечего, — и тогда
 * возвращается ровно та же строка.
 */
export function feminizeSelfReference(input: string): GenderFix {
  const spans = protectedSpans(input);
  const guarded = (index: number) => spans.some(([from, to]) => index >= from && index < to);
  const handedOver = (index: number) =>
    HANDOVER.test(input.slice(Math.max(0, index - 48), index));
  // Правки собираются по исходному тексту и применяются одной сборкой:
  // менять строку на ходу значит сдвигать смещения следующих совпадений.
  const edits: Edit[] = [];
  const add = (from: number, word: string) => {
    const fixed = feminineForm(word);
    if (!fixed || fixed === word) return;
    if (edits.some((edit) => edit.from === from)) return;
    edits.push({ from, to: from + word.length, text: fixed, was: word });
  };

  for (const match of input.matchAll(STANDALONE_I)) {
    const start = match.index ?? 0;
    if (guarded(start) || handedOver(start)) continue;
    // За «я» может стоять пара служебных слов — «я уже», «я не», «я
    // тебе». Дальше второго служебного слова подлежащее обычно уже
    // другое, и угадывать не нужно.
    let cursor = start + match[0].length;
    for (let step = 0; step < 3; step += 1) {
      NEXT_WORD.lastIndex = cursor;
      const next = NEXT_WORD.exec(input);
      if (!next) break;
      const word = next[1] ?? "";
      const wordAt = next.index + next[0].length - word.length;
      if (step < 2 && FILLERS.has(word.toLocaleLowerCase("ru"))) {
        cursor = next.index + next[0].length;
        continue;
      }
      add(wordAt, word);
      break;
    }
  }

  for (const match of input.matchAll(OPENER)) {
    const start = match.index ?? 0;
    if (guarded(start) || handedOver(start)) continue;
    const [, lead = "", word = ""] = match;
    if (!OPENERS.has(word.toLocaleLowerCase("ru"))) continue;
    add(start + lead.length, word);
    // «Понял, записал.» — однородный ряд тех же коротких реплик.
    // Продолжение берётся только из того же закрытого списка: за
    // запятой может стоять что угодно, и угадывать здесь нельзя.
    let cursor = start + lead.length + word.length;
    for (;;) {
      SERIES.lastIndex = cursor;
      const next = SERIES.exec(input);
      const following = next?.[1] ?? "";
      if (!next || !OPENERS.has(following.toLocaleLowerCase("ru"))) break;
      add(next.index + next[0].length - following.length, following);
      cursor = next.index + next[0].length;
    }
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
