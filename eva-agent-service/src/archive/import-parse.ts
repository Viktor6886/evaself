/**
 * Разбор присланного архива в проверенные записи.
 *
 * Здесь только чтение и проверка: в базу отсюда ничего не уходит. Каждая
 * строка листа либо становится записью с проверенными значениями (те же
 * пределы и допустимые значения, что у ограничений таблиц), либо даёт
 * ошибку с номером строки Excel — и человек видит, что поправить, ещё до
 * записи.
 *
 * Файл — недоверенные данные. Из него не берётся ничего, что меняет
 * поведение системы в обход человека: подписи сверяются со списком
 * допустимых значений, ссылки между листами — ключи самого файла, а не
 * идентификаторы базы.
 */

import { isValidIanaTimezone } from "../time/local-date-time.js";
import {
  CellError, date, dateTime, decimal, fold, integer, jsonStructure, jsonValue, labelled, list,
  requiredText, stringList, text, yesNo,
} from "./format.js";
import { Budget, columnsOf, getter, isEmptyRow, keyValues, type Get } from "./import-cells.js";
import {
  ABOUT_FIELDS, ARCHIVE_FORMAT, ARCHIVE_VERSION, LABELS, MEMORY_FIELDS, NORTH_FIELDS, PROFILE_FIELDS,
  SHEETS, SHEET_ROW_LIMIT, type ArchiveSheet, type SheetId,
} from "./sheets.js";
import {
  ArchiveRejected, type NorthImport, type Parsed, type ParsedArchive, type ProfileImport, type RowError,
} from "./import-types.js";
import type { ReadCell, ReadSheet, ReadWorkbook } from "./xlsx-reader.js";
import { pacer } from "./pace.js";

export { ARCHIVE_ROW_LIMIT, TEXT_BUDGET } from "./import-cells.js";

interface Context {
  date1904: boolean;
  zone: string;
  errors: RowError[];
  warnings: string[];
  budget: Budget;
  /** Пауза для цикла событий, как только подряд набежало `QUANTUM_MS`. */
  pace(): Promise<void>;
}

async function tableRows<T>(
  definition: ArchiveSheet,
  source: ReadSheet,
  context: Context,
  required: string[],
  parse: (get: Get) => T | null,
): Promise<Array<Parsed<T>>> {
  const [header = [], ...rest] = source.rows;
  const positions = columnsOf(definition, header);
  const missing = required.filter((key) => !positions?.has(key));
  if (!positions || missing.length > 0) {
    const names = missing.map((key) => definition.columns.find((column) => column.key === key)?.header ?? key);
    context.errors.push({
      sheet: definition.name,
      row: 1,
      message: names.length > 0
        ? `нет столбца ${names.map((name) => `«${name}»`).join(", ")} — лист пропущен`
        : "не найдено ни одного знакомого столбца — лист пропущен",
    });
    return [];
  }
  const parsed: Array<Parsed<T>> = [];
  let taken = 0;
  for (let index = 0; index < rest.length && taken <= SHEET_ROW_LIMIT; index += 1) {
    await context.pace();
    const row = rest[index] ?? [];
    if (isEmptyRow(row, context.budget)) continue;
    taken += 1;
    if (taken > SHEET_ROW_LIMIT) break;
    // Строка с ошибкой — тоже в счёт: разбор её стоит столько же.
    context.budget.rows(1);
    const excelRow = index + 2;
    try {
      // `null` — строка законная, но загружать в ней нечего (например,
      // отказ отвечать в анкете): это не ошибка.
      const value = parse(getter(row, positions, context.budget));
      if (value !== null) parsed.push({ row: excelRow, value });
    } catch (error) {
      if (!(error instanceof CellError)) throw error;
      context.errors.push({ sheet: definition.name, row: excelRow, message: error.message });
    }
  }
  if (taken > SHEET_ROW_LIMIT) {
    context.warnings.push(`Лист «${definition.name}»: больше ${SHEET_ROW_LIMIT} строк, остальные не прочитаны.`);
  }
  return parsed;
}

const ref = (value: string | null): string | null => (value === null ? null : fold(value));

/**
 * Проверка пояса создаёт `Intl.DateTimeFormat` — десятки микросекунд; у
 * десяти тысяч задач файла пояс обычно один и тот же.
 */
const zoneValidity = new Map<string, boolean>();
function validZone(value: string): boolean {
  let valid = zoneValidity.get(value);
  if (valid === undefined) {
    valid = isValidIanaTimezone(value);
    if (zoneValidity.size < 1_000) zoneValidity.set(value, valid);
  }
  return valid;
}

function parseAbout(
  source: ReadSheet | undefined,
  fallbackZone: string,
  budget: Budget,
): { recognized: boolean; zone: string } {
  if (!source) return { recognized: false, zone: fallbackZone };
  // Ошибки «О файле» человеку не показываются: из листа берутся только
  // формат, версия и пояс, а остальное в нём — справка.
  const values = keyValues(source, budget, []);
  // Неразборчивое значение справки — как пустое: файл без формата
  // разбирается как чужая таблица, а не падает.
  const cell = (label: string, max: number): string | null => {
    try {
      return text(values.get(fold(label))?.cell ?? null, max);
    } catch (error) {
      if (error instanceof CellError) return null;
      throw error;
    }
  };
  const format = cell(ABOUT_FIELDS.format, 100);
  if (format !== null && format !== ARCHIVE_FORMAT) {
    throw new ArchiveRejected("Это не архив Евы: в листе «О файле» указан другой формат.");
  }
  const version = Number(cell(ABOUT_FIELDS.version, 10));
  if (format !== null && Number.isFinite(version) && version > ARCHIVE_VERSION) {
    throw new ArchiveRejected("Архив сделан более новой версией Евы. Обновите сервис и загрузите файл снова.");
  }
  const zone = cell(ABOUT_FIELDS.zone, 100);
  return {
    recognized: format === ARCHIVE_FORMAT,
    zone: zone && validZone(zone) ? zone : fallbackZone,
  };
}

function parseProfile(source: ReadSheet, context: Context): ProfileImport | null {
  const values = keyValues(source, context.budget, context.errors);
  const profile: ProfileImport = {};
  const sheetName = "Профиль";
  for (const field of PROFILE_FIELDS) {
    if (!field.importable) continue;
    const found = values.get(fold(field.label));
    if (!found) continue;
    const cell = found.cell;
    try {
      switch (field.key) {
        case "first_name":
        case "last_name":
        case "city": {
          const value = text(cell, 200);
          if (value) profile[field.key] = value;
          break;
        }
        case "timezone": {
          const value = text(cell, 100);
          if (value && !validZone(value)) throw new CellError(`часовой пояс «${value}» неизвестен`);
          if (value) profile.timezone = value;
          break;
        }
        case "country_code": {
          const value = text(cell, 10)?.toUpperCase() ?? null;
          if (value && !/^[A-Z]{2}$/.test(value)) throw new CellError("код страны — две латинские буквы, например RU");
          if (value) profile.country_code = value;
          break;
        }
        case "response_mode": {
          const value = labelled(cell, LABELS.responseMode, field.label);
          if (value) profile.response_mode = value;
          break;
        }
        case "agent_mode": {
          const value = labelled(cell, LABELS.agentMode, field.label);
          if (value) profile.agent_mode = value;
          break;
        }
        case "use_emoji":
        case "heartbeat_enabled": {
          const value = yesNo(cell, field.label);
          if (value !== null) profile[field.key] = value;
          break;
        }
        default:
          break;
      }
    } catch (error) {
      if (!(error instanceof CellError)) throw error;
      context.errors.push({ sheet: sheetName, row: found.row, message: `«${field.label}»: ${error.message}` });
    }
  }
  return Object.keys(profile).length > 0 ? profile : null;
}

function parseNorth(source: ReadSheet, context: Context): NorthImport | null {
  const values = keyValues(source, context.budget, context.errors);
  const spend = (structure: number) => context.budget.json(structure);
  let row = 1;
  const get = (key: string): ReadCell => {
    const field = NORTH_FIELDS.find((item) => item.key === key)!;
    const found = values.get(fold(field.label));
    if (found) row = found.row;
    return found?.cell ?? null;
  };
  try {
    const north: NorthImport = {
      desired_direction: text(get("desired_direction"), 5_000),
      why_it_matters: text(get("why_it_matters"), 5_000),
      values: jsonValue(get("values"), "Ценности", spend) ?? [],
      conflicts: jsonValue(get("conflicts"), "Что мешает", spend) ?? [],
      reduce_list: jsonValue(get("reduce_list"), "Что сократить", spend) ?? [],
      acceptable_cost: text(get("acceptable_cost"), 5_000),
      unacceptable_cost: text(get("unacceptable_cost"), 5_000),
      user_confirmed: yesNo(get("user_confirmed"), "Подтверждено мной") ?? false,
    };
    const empty = !north.desired_direction && !north.why_it_matters && !north.acceptable_cost
      && !north.unacceptable_cost && [north.values, north.conflicts, north.reduce_list]
      .every((value) => Array.isArray(value) && value.length === 0);
    return empty ? null : north;
  } catch (error) {
    if (!(error instanceof CellError)) throw error;
    context.errors.push({ sheet: "Направление", row, message: error.message });
    return null;
  }
}

/**
 * Разобрать книгу. `zone` — текущий пояс человека: им читаются даты
 * файла, в котором пояс не указан.
 */
export async function parseArchive(book: ReadWorkbook, options: { zone: string }): Promise<ParsedArchive> {
  const byName = new Map(book.sheets.map((item) => [fold(item.name), item]));
  const find = (id: SheetId) => {
    const definition = SHEETS.find((item) => item.id === id)!;
    return { definition, source: byName.get(fold(definition.name)) };
  };
  const budget = new Budget();
  const spend = (structure: number) => budget.json(structure);
  const about = parseAbout(find("about").source, options.zone, budget);
  const context: Context = {
    date1904: book.date1904,
    zone: about.zone,
    errors: [],
    warnings: [],
    budget,
    pace: pacer(),
  };
  const when = { date1904: book.date1904, zone: about.zone };
  const parsed: ParsedArchive = {
    recognized: about.recognized,
    zone: about.zone,
    sheetsFound: [],
    readOnlySheets: [],
    profile: null,
    questionnaire: [],
    north: null,
    goals: [],
    results: [],
    tasks: [],
    journal: [],
    people: [],
    notes: [],
    checkins: [],
    budget: [],
    decisions: [],
    memory: [],
    errors: context.errors,
    warnings: context.warnings,
  };
  for (const definition of SHEETS) {
    if (definition.id === "about") continue;
    const source = byName.get(fold(definition.name));
    if (!source) continue;
    parsed.sheetsFound.push(definition.id);
    if (!definition.importable && definition.id !== "memory") parsed.readOnlySheets.push(definition.name);
  }
  const each = async <T>(id: SheetId, required: string[], parse: (get: Get) => T | null): Promise<Array<Parsed<T>>> => {
    const { definition, source } = find(id);
    return source ? await tableRows(definition, source, context, required, parse) : [];
  };

  const profileSheet = find("profile").source;
  if (profileSheet) parsed.profile = parseProfile(profileSheet, context);
  const northSheet = find("north").source;
  if (northSheet) parsed.north = parseNorth(northSheet, context);

  parsed.questionnaire = await each("questionnaire", ["field_key", "value"], (get) => {
    const key = requiredText(get("field_key"), 100, "Код поля");
    if (!/^[a-z][a-z0-9_]{0,99}$/.test(key)) throw new CellError("код поля — латиница, например city");
    const status = labelled(get("status"), LABELS.profileStatus, "Статус");
    // Отказ отвечать, «не относится» и устаревший ответ — не ответы: их
    // выгрузка показывает, а загрузка пропускает молча. Иначе собственный
    // архив человека возвращался бы с «ошибками» в каждой такой строке.
    if (status !== null && status !== "candidate" && status !== "confirmed") return null;
    if (text(get("value"), 10_000) === null && status === null) return null;
    const value = requiredText(get("value"), 10_000, "Ответ");
    // Ответ-объект или список JSON разбирается при записи — и платит за
    // это из того же бюджета файла, что и JSON листов.
    if (value.startsWith("[") || value.startsWith("{")) spend(jsonStructure(value));
    return {
      field_key: key,
      value,
      // Подтверждённым ответ остаётся, только если человек подтвердил
      // его сам; всё остальное возвращается предположением.
      status: status === "confirmed" ? "confirmed" as const : "candidate" as const,
    };
  });

  parsed.goals = await each("goals", ["title"], (get) => ({
    ref: ref(text(get("ref"), 50)),
    parent: ref(text(get("parent"), 50)),
    title: requiredText(get("title"), 500, "Название"),
    life_area: text(get("life_area"), 200),
    horizon: text(get("horizon"), 100),
    why_it_matters: text(get("why_it_matters"), 5_000),
    result_artifact: text(get("result_artifact"), 5_000),
    target_date: date(get("target_date"), when, "Срок"),
    success_criteria: jsonValue(get("success_criteria"), "Критерии успеха", spend) ?? [],
    minimum_version: text(get("minimum_version"), 5_000),
    target_version: text(get("target_version"), 5_000),
    constraints: jsonValue(get("constraints"), "Ограничения", spend) ?? [],
    learning_goal: text(get("learning_goal"), 5_000),
    review_condition: text(get("review_condition"), 2_000),
    stop_condition: text(get("stop_condition"), 2_000),
    priority: integer(get("priority"), 1, 5, "Приоритет") ?? 3,
    status: labelled(get("status"), LABELS.goalStatus, "Статус") ?? "draft",
    vector_stage: labelled(get("vector_stage"), LABELS.goalStage, "Этап") ?? "north",
    user_confirmed: yesNo(get("user_confirmed"), "Подтверждена мной") ?? false,
    created_at: dateTime(get("created_at"), when, "Создана"),
    completed_at: dateTime(get("completed_at"), when, "Завершена"),
  }));

  parsed.results = await each("results", ["goal", "title"], (get) => ({
    ref: ref(text(get("ref"), 50)),
    goal: ref(requiredText(get("goal"), 50, "Цель"))!,
    parent: ref(text(get("parent"), 50)),
    title: requiredText(get("title"), 500, "Название"),
    result_artifact: text(get("result_artifact"), 5_000),
    success_criteria: jsonValue(get("success_criteria"), "Критерии успеха", spend) ?? [],
    minimum_version: text(get("minimum_version"), 5_000),
    target_date: date(get("target_date"), when, "Срок"),
    sort_order: integer(get("sort_order"), -100_000, 100_000, "Порядок") ?? 100,
    status: labelled(get("status"), LABELS.resultStatus, "Статус") ?? "draft",
    is_checkpoint: yesNo(get("is_checkpoint"), "Контрольная точка") ?? false,
    is_external: yesNo(get("is_external"), "Зависит от других") ?? false,
    external_dependency: text(get("external_dependency"), 2_000),
    is_critical_path: yesNo(get("is_critical_path"), "Критический путь") ?? false,
    fallback_plan: text(get("fallback_plan"), 5_000),
    first_action: text(get("first_action"), 2_000),
    progress_percent: integer(get("progress_percent"), 0, 100, "Прогресс") ?? 0,
    completed_at: dateTime(get("completed_at"), when, "Готов"),
  }));

  parsed.tasks = await each("tasks", ["title"], (get) => {
    const timezone = text(get("timezone"), 100);
    if (timezone && !validZone(timezone)) throw new CellError(`часовой пояс «${timezone}» неизвестен`);
    const cron = text(get("cron_expression"), 100);
    // «Повторять» без выражения повтора — разовая задача: без cron
    // планировщику не из чего считать следующий срок.
    const repeat = (yesNo(get("repeat_enabled"), "Повторять") ?? false) && cron !== null;
    return {
      title: requiredText(get("title"), 500, "Название"),
      description: text(get("description"), 5_000),
      kind: labelled(get("kind"), LABELS.taskKind, "Вид") ?? "reminder",
      status: labelled(get("status"), LABELS.taskStatus, "Статус") ?? "open",
      priority: integer(get("priority"), 1, 5, "Приоритет") ?? 3,
      due_at: dateTime(get("due_at"), when, "Срок"),
      remind_at: dateTime(get("remind_at"), when, "Напомнить"),
      cron_expression: cron,
      repeat_enabled: repeat,
      timezone,
      reminders_enabled: yesNo(get("reminders_enabled"), "Напоминания включены") ?? true,
      goal: ref(text(get("goal"), 50)),
      result: ref(text(get("result"), 50)),
      estimated_minutes: integer(get("estimated_minutes"), 1, 1440, "Минут на задачу"),
      energy_required: integer(get("energy_required"), 1, 5, "Нужно энергии"),
      created_at: dateTime(get("created_at"), when, "Создана"),
      completed_at: dateTime(get("completed_at"), when, "Выполнена"),
    };
  });

  parsed.journal = await each("journal", ["local_date", "content"], (get) => {
    const localDate = date(get("local_date"), when, "Дата");
    if (!localDate) throw new CellError("не заполнено поле «Дата»");
    const people = list(get("people"), 20, 200, "Люди");
    // Каждое упоминание человека — запись в базе (карточка и связь), и
    // считается оно наравне со строками.
    budget.rows(people.length);
    return {
      local_date: localDate,
      title: text(get("title"), 500),
      // Предел — не форма дневника (20 000), а то, что вмещает файл:
      // запись, сохранённая раньше другим путём, возвращается целиком.
      content: requiredText(get("content"), 64_000, "Запись"),
      mood: labelled(get("mood"), LABELS.mood, "Настроение"),
      energy: integer(get("energy"), 1, 10, "Энергия"),
      people,
      created_at: dateTime(get("created_at"), when, "Создана"),
    };
  });

  parsed.people = await each("people", ["display_name"], (get) => ({
    display_name: requiredText(get("display_name"), 200, "Имя"),
    relation: text(get("relation"), 200),
  }));

  parsed.notes = await each("notes", ["title", "content"], (get) => ({
    title: requiredText(get("title"), 500, "Заголовок"),
    content: requiredText(get("content"), 100_000, "Текст"),
    category: text(get("category"), 200),
    tags: (text(get("tags"), 2_000) ?? "").split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 50)
      .map((tag) => tag.slice(0, 100)),
    pinned: yesNo(get("pinned"), "Закреплена") ?? false,
    entry_type: labelled(get("entry_type"), LABELS.noteType, "Тип") ?? "note",
    created_at: dateTime(get("created_at"), when, "Создана"),
  }));

  parsed.checkins = await each("checkins", ["local_date", "mood", "energy", "tension"], (get) => {
    const localDate = date(get("local_date"), when, "Дата");
    const mood = labelled(get("mood"), LABELS.mood, "Настроение");
    const energy = integer(get("energy"), 1, 10, "Энергия");
    const tension = integer(get("tension"), 1, 10, "Напряжение");
    if (!localDate || !mood || energy === null || tension === null) {
      throw new CellError("нужны дата, настроение, энергия и напряжение");
    }
    return { local_date: localDate, mood, energy, tension, note: text(get("note"), 2_000) };
  });

  parsed.budget = await each("budget", ["occurred_on", "amount"], (get) => {
    const occurred = date(get("occurred_on"), when, "Дата");
    const amount = decimal(get("amount"), "Сумма");
    if (!occurred || amount === null) throw new CellError("нужны дата и сумма");
    const minor = Math.round(Math.abs(amount) * 100);
    if (!Number.isSafeInteger(minor) || minor > 1e15) throw new CellError("«Сумма»: слишком большое число");
    const currency = (text(get("currency"), 10) ?? "RUB").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new CellError("«Валюта»: три латинские буквы, например RUB");
    // Отрицательная сумма — обычная запись расхода в таблицах; в базе сумма без знака.
    const type = labelled(get("entry_type"), LABELS.budgetType, "Тип") ?? "expense";
    const raw = decimal(get("quantity"), "Количество");
    // Столбец — numeric(12,3): три знака после запятой и меньше миллиарда.
    const quantity = raw === null ? null : Math.round(raw * 1_000) / 1_000;
    if (quantity !== null && (quantity < 0 || quantity >= 1e9)) throw new CellError("«Количество»: от 0 до 999 999 999");
    return {
      occurred_on: occurred,
      entry_type: type,
      amount_minor: minor,
      currency,
      category: text(get("category"), 200),
      store: text(get("store"), 300),
      description: text(get("description"), 1_000),
      payment_method: text(get("payment_method"), 100),
      quantity,
    };
  });

  parsed.decisions = await each("decisions", ["question"], (get) => ({
    question: requiredText(get("question"), 2_000, "Вопрос"),
    options: stringList(get("options"), 50, 1_000, "Варианты", spend),
    facts: stringList(get("facts"), 50, 1_000, "Факты", spend),
    assumptions: stringList(get("assumptions"), 50, 1_000, "Допущения", spend),
    criteria: stringList(get("criteria"), 50, 1_000, "Критерии", spend),
    risks: stringList(get("risks"), 50, 1_000, "Риски", spend),
    selected_option: text(get("selected_option"), 1_000),
    confidence: integer(get("confidence"), 0, 100, "Уверенность"),
    reversible: yesNo(get("reversible"), "Обратимо"),
    cheap_test: text(get("cheap_test"), 2_000),
    review_at: date(get("review_at"), when, "Пересмотреть"),
    actual_result: text(get("actual_result"), 5_000),
    status: labelled(get("status"), LABELS.decisionStatus, "Статус") ?? "open",
    created_at: dateTime(get("created_at"), when, "Создано"),
  }));

  const memorySheet = find("memory").source;
  if (memorySheet) {
    const values = keyValues(memorySheet, budget, context.errors);
    for (const field of MEMORY_FIELDS) {
      const value = text(values.get(fold(field.label))?.cell ?? null, 200_000);
      if (value) parsed.memory.push({ label: field.label, value });
    }
  }
  return parsed;
}
