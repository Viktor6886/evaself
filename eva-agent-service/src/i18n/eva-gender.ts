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
  ["пошёл", "пошла"],
  ["пришёл", "пришла"],
  ["нашёл", "нашла"],
  ["зашёл", "зашла"],
  ["ушёл", "ушла"],
  ["вошёл", "вошла"],
  ["дошёл", "дошла"],
  ["перешёл", "перешла"],
  ["прошёл", "прошла"],
  ["подошёл", "подошла"],
  ["отошёл", "отошла"],
  ["вышел", "вышла"],
  ["лёг", "легла"],
  ["ошибся", "ошиблась"],
  ["увлёкся", "увлеклась"],
  ["сбился", "сбилась"],
  ["привык", "привыкла"],
  // Частые формы обращения к человеку. Они нужны не только для речи
  // Евы о себе: тот же словарь используется строгим корректором «ты».
  ["важен", "важна"],
  ["нужен", "нужна"],
  ["интересен", "интересна"],
  ["расстроен", "расстроена"],
  ["взволнован", "взволнована"],
  ["удивлён", "удивлена"],
  ["удивлен", "удивлена"],
  ["хороший", "хорошая"],
  ["умный", "умная"],
  ["сильный", "сильная"],
  ["смелый", "смелая"],
  ["красивый", "красивая"],
  ["талантливый", "талантливая"],
  ["внимательный", "внимательная"],
  ["милый", "милая"],
  ["добрый", "добрая"],
  ["дорогой", "дорогая"],
  ["любимый", "любимая"],
  ["молодой", "молодая"],
  ["мужчина", "женщина"],
  ["парень", "девушка"],
]);

/** Каноническое предпочтение согласования с пользователем. */
export type UserGrammaticalGender = "masculine" | "feminine";

/** Женская форма -> мужская; неоднозначность допустима только после «ты». */
const REVERSE_IRREGULAR = new Map(
  [...IRREGULAR].map(([masculine, feminine]) => [feminine, masculine]),
);

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
  // Вводные и связки, за которыми подлежащее не меняется: «я, кажется,
  // понял», «как я и говорил». Каждое безопасно тем, что следующее слово
  // всё равно проходит проверку: в «я и Пётр решили» разбор доходит до
  // «Пётр», а исправить его нечем — правило молчит.
  "и", "кажется", "наверное", "конечно", "видимо", "похоже", "вот",
  "тогда", "сначала", "потом", "пока", "лично",
]);

/** Сколько служебных слов допускается между «я» и сказуемым. */
const MAX_FILLERS = 3;

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
  // Опущенное подлежащее в русском — это первое лицо: «Был рад помочь»,
  // «Ответил выше». О человеке так не говорят, о нём говорят с
  // подлежащим — «ты был», «он ответил».
  "был", "решил", "ответил", "спросил", "уточнил", "написал", "собрал",
  "перечитал", "почувствовал", "рассказал", "поправился", "ошибся",
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

/*
 * Короткая реплика, открывающая предложение: «Поняла.», «Поняла тебя.»
 *
 * Знака препинания сразу за словом больше не требуется: «Понял тебя» —
 * та же реплика о себе, и без этого она оставалась мужской. Вместо
 * этого отбрасывается предложение-вопрос: «Понял?» и «Готов ли ты?»
 * обращены к человеку, и род в них не её.
 */
const OPENER = /(^|[.!?\n]\s*)([А-ЯЁа-яё]+)/gu;

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
  const spans = protectedSpans(input);
  const guarded = (index: number) => spans.some(([from, to]) => index >= from && index < to);
  const handedOver = (index: number) =>
    HANDOVER.test(input.slice(Math.max(0, index - 48), index));
  // Правки собираются по исходному тексту и применяются одной сборкой:
  // менять строку на ходу значит сдвигать смещения следующих совпадений.
  const edits: Edit[] = [];
  const add = (from: number, word: string): boolean => {
    const fixed = feminineForm(word);
    if (!fixed || fixed === word) return false;
    if (edits.some((edit) => edit.from === from)) return false;
    edits.push({ from, to: from + word.length, text: fixed, was: word });
    return true;
  };

  /** Однородные сказуемые того же подлежащего: «подумала и решила». */
  const continueSeries = (from: number): void => {
    let cursor = from;
    for (;;) {
      SERIES.lastIndex = cursor;
      const next = SERIES.exec(input);
      const following = next?.[1] ?? "";
      if (!next || !following) break;
      const at = next.index + next[0].length - following.length;
      if (guarded(at) || !add(at, following)) break;
      cursor = next.index + next[0].length;
    }
  };

  for (const match of input.matchAll(STANDALONE_I)) {
    const start = match.index ?? 0;
    if (guarded(start) || handedOver(start)) continue;
    // За «я» может стоять пара служебных слов — «я уже», «я не», «я
    // тебе». Дальше второго служебного слова подлежащее обычно уже
    // другое, и угадывать не нужно.
    let cursor = start + match[0].length;
    for (let step = 0; step <= MAX_FILLERS; step += 1) {
      NEXT_WORD.lastIndex = cursor;
      const next = NEXT_WORD.exec(input);
      if (!next) break;
      const word = next[1] ?? "";
      const wordAt = next.index + next[0].length - word.length;
      if (step < MAX_FILLERS && FILLERS.has(word.toLocaleLowerCase("ru"))) {
        cursor = next.index + next[0].length;
        continue;
      }
      if (!add(wordAt, word)) break;
      // «Я подумала и решил» — половина исправленного хуже, чем ничего:
      // в одном предложении оказывалось два рода. Ряд продолжается,
      // пока следующее слово само поддаётся правилу; чужое подлежащее
      // его обрывает — «я спросил, он ответил» доходит до «он», и
      // править там нечего.
      continueSeries(wordAt + word.length);
      break;
    }
  }

  for (const match of input.matchAll(OPENER)) {
    const start = match.index ?? 0;
    if (guarded(start) || handedOver(start)) continue;
    const [, lead = "", word = ""] = match;
    if (!OPENERS.has(word.toLocaleLowerCase("ru"))) continue;
    const wordAt = start + lead.length;
    // Вопрос обращён к человеку: «Понял?», «Готов ли ты продолжить?».
    // Род в нём не её, и трогать его нельзя.
    if (sentenceEnd(input, wordAt) === "?") continue;
    if (!add(wordAt, word)) continue;
    // «Понял, записал», «Был рад» — тот же ряд коротких реплик о себе.
    // Продолжение берётся только из закрытого списка: за запятой может
    // стоять что угодно, и угадывать здесь нельзя.
    let cursor = wordAt + word.length;
    for (;;) {
      SERIES.lastIndex = cursor;
      const next = SERIES.exec(input);
      const following = next?.[1] ?? "";
      const safe = OPENERS.has(following.toLocaleLowerCase("ru"))
        || IRREGULAR.has(following.toLocaleLowerCase("ru"));
      if (!next || !safe) break;
      if (!add(next.index + next[0].length - following.length, following)) break;
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

/** Служебные слова между «ты» и согласуемым с ним сказуемым. */
const USER_FILLERS = new Set([
  "не", "уже", "ещё", "еще", "тоже", "сейчас", "точно", "правда",
  "ведь", "же", "бы", "очень", "совсем", "сегодня", "вчера", "теперь",
  "наверное", "кажется", "действительно", "просто", "всё", "все",
]);

const STANDALONE_YOU = /(?<![\p{L}\p{N}-])ты(?![\p{L}\p{N}-])/giu;
const BEFORE_YOU = /([а-яёА-ЯЁ-]+)\s+ли\s+ты(?=$|[\s,.!?;:])/giu;
const USER_SERIES = /\s+и\s+([а-яёА-ЯЁ-]+)/yu;
const USER_COMPLEMENT = /\s+([а-яёА-ЯЁ-]+)/yu;

/** Без «ты» только эти короткие вопросы надёжно обращены к человеку. */
const USER_QUESTION_OPENERS = new Set([
  "понял", "поняла", "готов", "готова", "рад", "рада", "согласен", "согласна",
  "уверен", "уверена", "устал", "устала", "занят", "занята", "свободен", "свободна",
  "расстроен", "расстроена", "взволнован", "взволнована", "удивлён", "удивлена",
  "сделал", "сделала", "решил", "решила", "смог", "смогла", "пришёл", "пришла",
  "нашёл", "нашла", "ушёл", "ушла", "закончил", "закончила", "начал", "начала",
]);

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
