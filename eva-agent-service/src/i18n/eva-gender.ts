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
  ["вынужден", "вынуждена"],
  ["убеждён", "убеждена"],
  ["убежден", "убеждена"],
  ["заинтересован", "заинтересована"],
  ["сосредоточен", "сосредоточена"],
  ["озадачен", "озадачена"],
  ["впечатлён", "впечатлена"],
  ["впечатлен", "впечатлена"],
  ["благодарен", "благодарна"],
  ["признателен", "признательна"],
  ["способен", "способна"],
  ["склонен", "склонна"],
  ["открыт", "открыта"],
  ["тронут", "тронута"],
  ["огорчён", "огорчена"],
  ["огорчен", "огорчена"],
  ["смущён", "смущена"],
  ["смущен", "смущена"],
  ["восхищён", "восхищена"],
  ["восхищен", "восхищена"],
  ["польщён", "польщена"],
  ["польщен", "польщена"],
  ["обеспокоен", "обеспокоена"],
  ["внимателен", "внимательна"],
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
  ["замёрз", "замёрзла"],
  ["замерз", "замерзла"],
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
  // Дополнение-местоимение между «я» и сказуемым: «я их разобрала»,
  // «я ему ответила». Подлежащим оно не бывает, так что «я» остаётся
  // единственным кандидатом.
  "их", "его", "её", "ее", "им", "ему", "ей", "нам", "мне", "всем", "всех",
  "ничего", "никому",
  // Вводные: «я, если честно, забыла», «я, признаться, не ожидала».
  "если", "честно", "признаться", "откровенно", "говоря", "кстати",
  // Наречия меры и времени: «я немного запутался», «я не так понял»,
  // «я всегда готов». Без них «я» не доходило до сказуемого, и ответ
  // оставался мужским. Подлежащим ни одно из них не бывает.
  "немного", "немножко", "чуть", "слегка", "совсем", "так", "всегда",
  "никогда", "опять", "снова", "теперь", "сегодня", "вчера", "раньше",
  "действительно", "искренне", "сильно", "обязательно", "рядом",
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
 * Существительные на «-л», которые в начале фразы выглядят как глагол.
 *
 * Общее правило «глагол прошедшего времени в начале фразы — это Ева о
 * себе» читает слово по окончанию, а окончание у них то же: «Сигнал
 * пропал» не должно стать «Сигнала пропал».
 */
const NOUNS_LIKE_PAST = new Set([
  "сигнал", "канал", "журнал", "финал", "материал", "персонал", "генерал",
  "адмирал", "идеал", "интервал", "капитал", "оригинал", "арсенал", "скандал",
  "карнавал", "подвал", "провал", "портал", "терминал", "потенциал",
  "профессионал", "криминал", "штурвал", "шквал", "минерал", "вокзал",
  "аврал", "бокал", "кинжал", "овал", "пьедестал", "ритуал", "мемориал",
  "сериал", "трибунал", "интеграл", "фингал", "запал", "накал", "причал",
  "урал", "байкал", "непал", "сенегал", "отдел", "раздел", "предел", "пробел",
  "удел", "павел", "дятел", "пепел", "ангел", "крокодил", "михаил", "гавриил",
  "даниил", "самуил", "караул", "разгул", "посул", "итог",
]);

/**
 * Глаголы, за которыми в начале фразы обычно стоит чужое подлежащее.
 *
 * «Пришёл ответ», «Позвонил курьер», «Прошёл месяц» — порядок слов
 * обратный, и говорит фраза не о Еве. Такие глаголы общим правилом не
 * правятся; о себе с ними Ева говорит через «я», а это правило их ловит.
 */
const INVERTED_SUBJECT_VERBS = new Set([
  "вышел", "наступил", "пропал", "упал", "выпал", "стал", "звонил", "позвонил",
  "приехал", "уехал", "прилетел", "улетел", "сработал", "заработал",
  "поступил", "прибыл", "убыл", "сгорел", "минул", "остыл", "опоздал",
  "висел", "лежал", "стоял", "сидел", "жил", "умирал", "выжил", "уцелел",
  "появлял", "пропадал", "звучал", "прозвучал", "раздался", "остался",
  "подошёл", "подъехал", "заехал", "пришёл", "прошёл", "ушёл",
]);

/**
 * Одушевлённые существительные в именительном падеже.
 *
 * «Получил ответ пользователь» — подлежащее стоит после дополнения. У
 * одушевлённых именительный отличается от винительного («пользователя»),
 * поэтому такое слово в той же части предложения надёжно называет
 * чужое подлежащее. У неодушевлённых («сервер») падежи совпадают, и
 * отличить подлежащее от дополнения нельзя — их здесь нет намеренно.
 */
const ANIMATE_SUBJECTS = new Set([
  "пользователь", "человек", "клиент", "сотрудник", "начальник", "руководитель",
  "преподаватель", "студент", "врач", "пациент", "собеседник", "друг", "брат",
  "отец", "муж", "сын", "ребёнок", "ребенок", "автор", "специалист", "менеджер",
  "директор", "коллега", "учитель", "ученик", "командир", "заведующий",
  "профессор", "декан", "курьер", "сосед", "партнёр", "партнер", "заказчик",
]);

/** Притяжательные по форме слова: за ними может стоять существительное. */
const POSSESSIVE_FILLERS = new Set(["его", "её", "ее", "их"]);

/** Местоимения-подлежащие: после них глагол уже не о Еве. */
const SUBJECT_PRONOUNS = new Set([
  "он", "она", "оно", "они", "кто", "никто", "ничто", "каждый", "всякий",
  "ты", "вы", "мы", "это", "всё", "все", "кто-то", "что-то", "кто-нибудь",
]);

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
  // «…, и пришёл он»: подлежащее за сказуемым — чужое, даже когда
  // форма нерегулярная и в общем правиле не проверяется.
  if (next && (SUBJECT_PRONOUNS.has(next.toLocaleLowerCase("ru"))
    || next[0] !== next[0]!.toLocaleLowerCase("ru"))) return false;
  if (IRREGULAR.has(lower) || isSelfPastPredicate(word, next)) return true;
  return /лся$/u.test(lower) && isSelfPastPredicate(word.slice(0, -2), next);
}

/**
 * Наречия, которые могут открывать фразу перед сказуемым о себе:
 * «Потом написала план», «Сначала проверила почту».
 */
const LEADING_ADVERBS = new Set([
  "потом", "затем", "сначала", "сперва", "сейчас", "уже", "также", "тоже",
  "заодно", "ещё", "еще", "вчера", "сегодня", "наконец", "сразу", "заранее",
  "дополнительно", "отдельно", "вдобавок", "параллельно", "попутно",
]);

/**
 * Короткие слова перед запятой в начале фразы: «Хорошо, записал»,
 * «Отлично, сохранил цель». Подлежащего они не несут, и сказуемое за
 * ними — то же опущенное первое лицо, что и в начале фразы.
 */
const LEADING_INTERJECTIONS = new Set([
  "хорошо", "отлично", "ок", "окей", "ладно", "да", "ага", "угу", "итак",
  "супер", "понятно", "конечно", "кстати", "готово", "принято", "так", "ну",
  "прости", "извини", "простите", "извините", "спасибо", "ой", "честно",
]);

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

/** Слова, с которых начинается другая часть предложения со своим подлежащим. */
const CLAUSE_BREAKERS = new Set([
  "а", "но", "однако", "зато", "что", "чтобы", "где", "куда", "откуда", "когда",
  "если", "пока", "хотя", "потому", "почему", "зачем", "как", "чем", "раз",
  "который", "которая", "которое", "которые", "которого", "которой", "которым",
]);

const CLAUSE_TOKEN = /([,—–:;(])|([а-яёА-ЯЁ-]+)/gu;

/**
 * Слова, после которых идёт реплика, предложенная человеку.
 *
 * «Попробуй сказать: я справился» — его слова, не её. Такой фрагмент
 * правке не подлежит, иначе Ева вложит человеку в рот чужой род.
 */
const HANDOVER =
  /(?:скажи|скажите|сказать|говоришь|говорит|напиши|напишите|написать|ответь|ответьте|фраз\w*|например|звучит|так и скажи)[^.!?\n]{0,24}$/iu;

/**
 * Пересказ чужих слов без кавычек: «Ты написал мне: я всё понял».
 *
 * После двоеточия за глаголом речи в прошедшем времени идут слова
 * человека, а не Евы. Косвенная речь («ты сказал, что я справилась»)
 * сюда не относится: там «я» — сама Ева.
 */
const REPORTED_SPEECH =
  /(?:написал|написала|писал|писала|сказал|сказала|говорил|говорила|отметил|отметила|ответил|ответила|спросил|спросила|пишешь|сообщил|сообщила)[^.!?\n:]{0,24}:\s*$/iu;

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
  const handedOver = (index: number) => {
    const before = input.slice(Math.max(0, index - 48), index);
    return HANDOVER.test(before) || REPORTED_SPEECH.test(before);
  };
  // Правки собираются по исходному тексту и применяются одной сборкой:
  // менять строку на ходу значит сдвигать смещения следующих совпадений.
  const edits: Edit[] = [];
  const add = (from: number, word: string): boolean => {
    // «Канал», «файл» — существительные на «-л»: их род не Евы.
    const lowerWord = word.toLocaleLowerCase("ru");
    if (NOUNS_LIKE_PAST.has(lowerWord) || /йл$/u.test(lowerWord)) return false;
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
      // «Был бы рад», «был не прав»: частица между связкой и
      // сказуемым подлежащего не меняет — сказуемое за ней то же.
      // Только внутри той же группы сказуемого: за запятой «не» открывает
      // косвенный вопрос — «я подумала, не пришёл ли поезд».
      if (/^(?:бы|не)$/iu.test(following) && /^\s+$/u.test(next[0].slice(0, next[0].length - following.length))) {
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
      const allowed = IRREGULAR.has(lower) || (joined && isSelfContinuation(following, afterWord));
      if (!allowed || guarded(at) || !add(at, following)) break;
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
  const continueClause = (from: number): void => {
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
        joined = true;
        continue;
      }
      const word = token[2] ?? "";
      const lower = word.toLocaleLowerCase("ru");
      if (lower === "и") {
        joined = true;
        continue;
      }
      if (CLAUSE_BREAKERS.has(lower) || SUBJECT_PRONOUNS.has(lower)) return;
      if (!joined) continue;
      const next = tokens[index + 1]?.[2] ?? "";
      const at = from + (token.index ?? 0);
      if (guarded(at)) return;
      const lowerIsSelf = isSelfContinuation(word, next);
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
    // За «я» может стоять пара служебных слов — «я уже», «я не», «я
    // тебе». Дальше второго служебного слова подлежащее обычно уже
    // другое, и угадывать не нужно.
    let cursor = start + match[0].length;
    let possessive = false;
    for (let step = 0; step <= MAX_FILLERS; step += 1) {
      NEXT_WORD.lastIndex = cursor;
      const next = NEXT_WORD.exec(input);
      if (!next) break;
      const word = next[1] ?? "";
      const wordAt = next.index + next[0].length - word.length;
      if (step < MAX_FILLERS && FILLERS.has(word.toLocaleLowerCase("ru"))) {
        possessive = POSSESSIVE_FILLERS.has(word.toLocaleLowerCase("ru"));
        cursor = next.index + next[0].length;
        continue;
      }
      // «Я его канал проверил»: «его» здесь притяжательное, и следующее
      // слово — существительное. Правится только форма, похожая на
      // сказуемое.
      const afterWord = /^\s*([А-ЯЁа-яё-]+)/u.exec(input.slice(wordAt + word.length))?.[1] ?? "";
      if (possessive && !IRREGULAR.has(word.toLocaleLowerCase("ru"))
        && !isSelfPastPredicate(word, afterWord)) break;
      if (!add(wordAt, word) && !isFeminineSelf(word, afterWord)) break;
      continueClause(wordAt + word.length);
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
    const [, lead = "", opening = ""] = match;
    let word = opening;
    let wordAt = start + lead.length;
    // «Потом написал план»: наречие перед сказуемым о себе.
    if (LEADING_ADVERBS.has(opening.toLocaleLowerCase("ru"))) {
      const shifted = /^(\s+)([А-ЯЁа-яё]+)/u.exec(input.slice(wordAt + opening.length));
      if (!shifted) continue;
      wordAt += opening.length + shifted[1]!.length;
      word = shifted[2]!;
    } else if (LEADING_INTERJECTIONS.has(opening.toLocaleLowerCase("ru"))) {
      // «Хорошо, записал»: сказуемое стоит за запятой.
      const shifted = /^(,\s*)([А-ЯЁа-яё]+)/u.exec(input.slice(wordAt + opening.length));
      if (shifted) {
        wordAt += opening.length + shifted[1]!.length;
        word = shifted[2]!;
      }
    }
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
    // «Понял, записал», «Был рад» — тот же ряд коротких реплик о себе.
    // Продолжение берётся только из закрытого списка: за запятой может
    // стоять что угодно, и угадывать здесь нельзя.
    let cursor = wordAt + word.length;
    for (;;) {
      SERIES.lastIndex = cursor;
      const next = SERIES.exec(input);
      const following = next?.[1] ?? "";
      const afterNext = input.slice(next ? next.index + next[0].length : 0);
      const nextFollowing = /^\s*([А-ЯЁа-яё-]+)/u.exec(afterNext)?.[1] ?? "";
      const safe = IRREGULAR.has(following.toLocaleLowerCase("ru"))
        || isSelfPastPredicate(following, nextFollowing);
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