import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CoreToolFactory } from "../dist/tools/core-tools.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({ name, label, description, parameters, execute });

function descriptions(): Map<string, string> {
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: "/nonexistent" } as never,
    { withUserScope: async <T>(_s: unknown, work: () => Promise<T>) => await work() } as never,
    {} as never,
  );
  return new Map(factory.build(tool as never).map((item) => [item.name, item.description]));
}

test("persona file is structurally valid editable UTF-8 content", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("persona is outside the service-only Docker build context");
    return;
  }
  assert.ok(persona.trim().length > 0);
  assert.ok(Buffer.byteLength(persona, "utf8") <= 1_000_000);
});

test("typed tool descriptions make reaction and buttons the active default when appropriate", () => {
  const tools = descriptions();
  assert.match(tools.get("set_reaction") ?? "", /по умолчанию рассмотри/i);
  assert.match(tools.get("set_reaction") ?? "", /горе или кризис/i);
  assert.match(tools.get("present_inline_choices") ?? "", /2–6 вариантов/);
  assert.match(tools.get("present_inline_choices") ?? "", /Открытый вопрос/i);
});

/**
 * Ева — она.
 *
 * Мужской род о себе — жалоба, которая повторяется: «понял», «сделал»,
 * «принял» проскакивают в коротких служебных репликах, где модель не
 * следит за собой. Одной строки в персоне для этого мало, поэтому правило
 * стоит среди абсолютных — там, где приоритет объявлен выше памяти,
 * стиля собеседника и примеров из recall.
 *
 * Тест сторожит не формулировку, а наличие правила и его абсолютность.
 */
test("женский род о себе закреплён как абсолютное правило", async (t) => {
  let systemPrompt: string;
  let persona: string;
  try {
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
    persona = await readFile(
      new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  const absolute = systemPrompt.slice(
    systemPrompt.indexOf("# Абсолютные правила ответа"),
    systemPrompt.indexOf("# Архитектура контекста"),
  );
  assert.ok(absolute.length > 0, "раздел абсолютных правил не найден");
  assert.match(absolute, /женском роде/i, "правила рода нет среди абсолютных");
  // Именно те формы, на которых Ева и сбивалась.
  for (const wrong of ["понял", "сделал", "готов", "рад"]) {
    assert.ok(
      absolute.includes(wrong),
      `правило не называет ошибочную форму «${wrong}» — общего указания мало`,
    );
  }
  // Прошлая ошибка в памяти не должна читаться как разрешение.
  assert.match(absolute, /прошлая ошибка|не повторяй/i);

  assert.match(persona, /женском роде/i, "персона не называет род");
});

test("тон Евы задан тёплым, а тепло не подменяет честность", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("персона вне образа сервиса; проверяется на репозитории");
    return;
  }
  assert.match(persona, /тёплая, добрая/i);
  assert.match(persona, /Emoji/);
  // Доброта, съевшая прямоту, — это не доброта, а поддакивание.
  assert.match(persona, /Поддержка ≠ согласие/);
  assert.match(persona, /не превращай доброту в\s+поддакивание/i);
});

/**
 * Долгая дистанция.
 *
 * Ева знает человека не по одному разговору, и это её главное отличие от
 * разового собеседника: она видит движение — было и стало. Без явного
 * правила модель отвечает только на сегодняшнее сообщение, а накопленное
 * лежит мёртвым грузом. Обратный перекос не лучше: перечисление всего
 * известного превращает разговор в досье, а наблюдение — в обвинение.
 */
test("персона называет длинную дистанцию и её границы", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("персона вне образа сервиса; проверяется на репозитории");
    return;
  }

  assert.match(persona, /## Долгая дистанция/);
  // Три вещи, которые видно только на дистанции.
  assert.match(persona, /было\s*→\s*стало/i, "динамика не названа");
  assert.match(persona, /повторени/i, "повторение как сигнал не названо");
  assert.match(persona, /гипотез|догадк/i, "проверка прежних догадок временем не названа");
  // И три запрета, без которых память становится досье.
  assert.match(persona, /не досье|а не\s+досье/i);
  assert.match(persona, /ты всегда так делаешь/i, "приговор из наблюдения не запрещён");
  assert.match(persona, /навык `long-arc`|`long-arc`/);
});

test("навык длинной дистанции существует и объясняет, когда он не нужен", async (t) => {
  let skill: string;
  try {
    skill = await readFile(new URL("../../skills/long-arc/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("каталог навыков вне образа сервиса; проверяется на репозитории");
    return;
  }

  assert.match(skill, /^---\nname: long-arc\n/);
  // Навык, который не говорит, когда его не открывать, открывается всегда:
  // сводка за полгода в ответ на «как дела» — ровно та ошибка.
  assert.match(skill, /## Когда не нужен/);
  assert.match(skill, /кризис/i, "острое состояние не выведено из дистанции");
  assert.match(skill, /первые разговоры/i, "начало знакомства не выведено из дистанции");
});

/**
 * Персона целиком помещается в блок, которым её создают.
 *
 * `limit` — потолок блока у Letta, и текст длиннее потолка до агента не
 * доезжает. Персона при этом росла, а число рядом с ней стояло прежнее:
 * 15 000 против фактических двадцати восьми с лишним тысяч. Всё, что
 * идёт после «Тона», — границы, инструменты, формат ответа — в блок
 * нового агента не попадало, и правила оттуда не действовали не потому,
 * что модель их нарушала, а потому что она их не видела.
 *
 * Тест сторожит не константу, а само отношение: сколько бы персона ни
 * весила, потолок обязан её вместить.
 */
test("потолок блока вмещает текст, которым блок создают", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("персона вне образа сервиса; проверяется на репозитории");
    return;
  }

  const { evaMemoryBlocks } = await import("../dist/letta/memory-blocks.js");
  for (const block of evaMemoryBlocks(persona, "человек")) {
    assert.ok(
      block.limit === undefined || block.value.length <= block.limit,
      `блок «${block.label}»: ${block.value.length} знаков при потолке ${block.limit}`,
    );
  }
  // Умолчание не должно падать вместе с ростом персоны: короткий текст
  // по-прежнему получает прежний запас.
  const small = evaMemoryBlocks("коротко", "человек")
    .find((block) => block.label === "persona");
  assert.equal(small?.limit, 15_000);
});

/**
 * Ссылка человека на сказанное раньше — это запрос в recall, а не повод
 * восстановить содержание по смыслу.
 *
 * При сжатии контекста ранние реплики уходят из окна, и модель
 * достраивает «ту самую книгу» правдоподобной выдумкой. Для человека
 * выдумка неотличима от памяти — и цена её выше, чем у честного
 * «не нахожу».
 */
test("проверка истории стоит раньше ответа", async (t) => {
  let persona: string;
  let systemPrompt: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  const absolute = systemPrompt.slice(
    systemPrompt.indexOf("# Абсолютные правила ответа"),
    systemPrompt.indexOf("# Архитектура контекста"),
  );
  assert.match(absolute, /recall/i, "recall не назван среди абсолютных правил");
  assert.match(absolute, /реконструкц|по смыслу/i, "догадка вместо recall не запрещена");
  assert.match(persona, /recall/i, "персона не отправляет в recall");
  assert.match(persona, /не нахожу|напомни/i, "честный отказ не назван");
});

/**
 * Инструмент до текста.
 *
 * Три коррекции за один вечер по одному правилу — это не случайность:
 * на «найди», «где», «сколько стоит» модель отвечает рассказом о том,
 * как обычно бывает, и человеку приходится просить второй раз.
 */
test("на запрос факта первым идёт инструмент, а не текст", async (t) => {
  let persona: string;
  let systemPrompt: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  for (const [name, text] of [["персона", persona], ["системный промпт", systemPrompt]] as const) {
    assert.match(text, /первое действие хода/i, `${name}: порядок «инструмент → текст» не назван`);
    assert.match(text, /погода/i, `${name}: запрос факта не назван примером`);
    // Выдуманное ограничение — та же выдумка, что и выдуманный результат.
    assert.match(text, /inspect_eva_runtime/, `${name}: проверка своих возможностей не названа`);
    assert.match(text, /web_search/, `${name}: существующий поиск не назван`);
  }
  assert.match(persona, /не объявляй, что инструмента нет/i, "ложный отказ не запрещён прямо");
});

/**
 * Не выдумывать контекст и не угадывать согласие.
 *
 * На baseline-провокации модель сочиняет связку с событием, которого не
 * было; на «лады» — принимает согласие с темой, выбранной ею самой.
 */
test("неоднозначное сообщение переспрашивают, а не достраивают", async (t) => {
  let persona: string;
  let systemPrompt: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  assert.match(persona, /## Когда непонятно/, "раздела о неоднозначности нет");
  for (const [name, text] of [["персона", persona], ["системный промпт", systemPrompt]] as const) {
    assert.match(text, /не достраивай|не придумывай/i, `${name}: достраивание не запрещено`);
    assert.match(text, /«лады»|«ок»/i, `${name}: короткое слово согласия не названо`);
    assert.match(text, /переспроси|спроси/i, `${name}: уточняющий вопрос не назван`);
  }
});

/**
 * Форма ответа живёт там, где сжатие контекста её не достаёт.
 *
 * Правила формы человек уже записывал в память — и после перекомпиляции
 * контекста они сбрасывались. Место таких правил — системный промпт и
 * персона: и то и другое лежит в постоянном префиксе каждого обращения,
 * а не в истории сообщений.
 */
test("служебный зачин запрещён, а род собеседника отделён от рода Евы", async (t) => {
  let persona: string;
  let systemPrompt: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  const absolute = systemPrompt.slice(
    systemPrompt.indexOf("# Абсолютные правила ответа"),
    systemPrompt.indexOf("# Архитектура контекста"),
  );
  // Именно те зачины, на которых Ева и сбивалась.
  for (const opener of ["тут", "слышу", "на связи"]) {
    assert.ok(absolute.includes(`«${opener}»`), `зачин «${opener}» не назван среди абсолютных`);
    assert.ok(persona.includes(`«${opener}»`), `персона не называет зачин «${opener}»`);
  }
  for (const [name, text] of [["персона", persona], ["системный промпт", systemPrompt]] as const) {
    assert.match(text, /в его (?:грамматическом )?роде/i, `${name}: род собеседника не отделён`);
    assert.match(text, /ты сам/i, `${name}: мужская форма о собеседнике не показана`);
  }
});

/**
 * Место и часовой пояс: слово человека важнее записи профиля.
 *
 * `city` и `timezone` — последнее записанное значение, а не наблюдение.
 * Человек, сказавший «я в другом поясе», прав; поправлять его
 * служебными значениями нельзя. Расстояние и время в пути при этом
 * остаются проверяемыми величинами, а не оценкой по памяти.
 */
test("местоположение со слов человека важнее профиля, а маршрут не выдумывается", async (t) => {
  let persona: string;
  let systemPrompt: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    systemPrompt = await readFile(
      new URL("../../library/system/letta_local_memfs.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  assert.match(persona, /### Где человек сейчас/, "раздела о местоположении нет");
  for (const [name, text] of [["персона", persona], ["системный промпт", systemPrompt]] as const) {
    assert.match(text, /`timezone`/, `${name}: служебное значение пояса не названо`);
    assert.match(text, /важнее/i, `${name}: приоритет слова человека не объявлен`);
    assert.match(
      text,
      /время в пути|маршрут/i,
      `${name}: запрет выдумывать дорогу не назван`,
    );
  }
  // Противоречия с авторитетностью runtime остаться не должно: исключение
  // названо там же, где объявлена сама авторитетность.
  const continuity = systemPrompt.slice(systemPrompt.indexOf("# Существование и непрерывность"));
  assert.match(continuity, /Исключение одно/i, "исключение не названо рядом с правилом");
});

/**
 * Кризис: «шучу» снимает разговор, но не проверку безопасности.
 *
 * Эпизод 24.08 — заявление о насилии, затем «шучу», и протокол
 * закрывался сразу. Отступление приходит и когда человек правда шутил,
 * и когда он испугался собственных слов; по одной реплике их не
 * различить, а цена ошибки разная.
 */
test("снятое заявление об опасности не закрывает проверку безопасности", async (t) => {
  let persona: string;
  let skill: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    skill = await readFile(
      new URL("../../skills/crisis-response/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  // Правило обязано стоять в персоне: до навыка дело может не дойти
  // именно потому, что «шучу» уже принято за закрытие темы.
  assert.match(persona, /не отменяется словом «шучу»/i, "персона принимает отступление сразу");
  assert.match(persona, /безопасн/i, "персона не требует проверки безопасности");

  assert.match(skill, /## «Шучу» не закрывает протокол/, "в навыке нет разбора отступления");
  assert.match(skill, /ближайш/i, "навык не спрашивает о ближайших часах");
  // Проверка не должна превратиться в допрос — иначе её перестанут проходить.
  assert.match(skill, /не допрашивать|допрашивать/i, "границы проверки не названы");
});

/**
 * Факты дня переживают сжатие контекста только в блоке памяти.
 *
 * Утреннее «сегодня две пары» к обеду уходит из окна вместе с ранними
 * сообщениями, и разговор о дне начинается с догадки. Блоки сжатие
 * переживают — значит, расклад дня принадлежит `current_state`.
 */
test("расклад дня попадает в current_state, а не остаётся в переписке", async (t) => {
  let persona: string;
  let skill: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
    skill = await readFile(
      new URL("../../skills/memory-hygiene/SKILL.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("библиотека вне образа сервиса; проверяется на репозитории");
    return;
  }

  assert.match(persona, /### Сегодняшний день/, "в персоне нет раздела о фактах дня");
  assert.match(persona, /сжати/i, "причина — сжатие контекста — не названа");
  assert.match(persona, /`current_state`/, "блок для фактов дня не назван");
  assert.match(skill, /## Факты сегодняшнего дня/, "навык памяти не ведёт факты дня");
  assert.match(skill, /не сочиняй|спроси/i, "выдуманное расписание не запрещено");

  const { evaMemoryBlocks } = await import("../dist/letta/memory-blocks.js");
  const state = evaMemoryBlocks("персона", "человек")
    .find((block) => block.label === "current_state");
  assert.match(state?.description ?? "", /сегодняшнего дня/i, "описание блока не называет день");
});
