/**
 * Состав архива: листы, их столбцы и подписи значений.
 *
 * Одно описание на оба направления. Выгрузка пишет заголовки отсюда,
 * загрузка по ним же узнаёт столбец — порядок столбцов человек может
 * менять, лишние столбцы пропускаются. Поэтому заголовок — часть формата:
 * переименование ломает загрузку уже выгруженных файлов, и меняется он
 * только вместе с `ARCHIVE_VERSION`.
 */

import type { ColumnKind } from "./xlsx-writer.js";

export const ARCHIVE_FORMAT = "evaself-archive";
export const ARCHIVE_VERSION = 1;

/** Сколько строк одного листа уходит в файл и принимается из файла. */
export const SHEET_ROW_LIMIT = 10_000;

/**
 * Текст длиннее ячейки Excel (32 767 знаков) продолжается в соседних
 * столбцах «… (продолжение N)» — столько, сколько нужно самому длинному
 * значению столбца. Предел одного значения — защита размера файла: длиннее
 * в базе ничего не пишется, и выгрузка называет обрезанное в «О файле».
 */
export const SPILL_CHUNK = 32_000;
export const MAX_VALUE_LENGTH = 1_000_000;

export interface ArchiveColumn {
  key: string;
  header: string;
  kind: ColumnKind;
  width?: number;
}

export type SheetId =
  | "about" | "profile" | "questionnaire" | "north" | "goals" | "results" | "tasks"
  | "journal" | "people" | "notes" | "checkins" | "budget" | "decisions"
  | "work_blocks" | "reviews" | "strategies" | "experiments" | "focus_days"
  | "focus_sessions" | "windows" | "conversations" | "documents" | "research"
  | "subscriptions" | "payments" | "tests" | "memory";

export interface ArchiveSheet {
  id: SheetId;
  name: string;
  /** Лист загружается обратно; остальные — только для просмотра. */
  importable: boolean;
  columns: readonly ArchiveColumn[];
}

// ---------------------------------------------------------------------
// подписи значений: в файле — по-русски, в базе — код
// ---------------------------------------------------------------------

export const LABELS = {
  taskStatus: { open: "открыта", in_progress: "в работе", done: "выполнена", canceled: "отменена" },
  taskKind: { reminder: "напоминание", action: "действие Евы" },
  goalStatus: { draft: "черновик", active: "в работе", paused: "на паузе", completed: "достигнута", abandoned: "оставлена" },
  goalStage: {
    north: "направление", result: "результат", map: "карта", action: "действие",
    feedback: "обратная связь", review: "пересмотр",
  },
  resultStatus: {
    draft: "черновик", ready: "можно начинать", in_progress: "в работе", completed: "готов",
    blocked: "заблокирован", skipped: "пропущен",
  },
  // Те же слова, что в дневнике Mini App.
  mood: { very_low: "тяжёлое", low: "сниженное", neutral: "спокойное", good: "хорошее", great: "отличное" },
  noteType: { note: "заметка", journal: "дневник", insight: "инсайт", decision: "решение" },
  budgetType: { income: "доход", expense: "расход" },
  decisionStatus: { open: "открыто", review: "на пересмотре", completed: "завершено", archived: "в архиве" },
  profileStatus: {
    missing: "нет ответа", candidate: "предположение", confirmed: "подтверждено",
    declined: "отказ отвечать", not_applicable: "не относится", superseded: "устарело",
  },
  responseMode: { text: "текст", both: "голос + текст", voice: "только голос" },
  agentMode: { companion: "собеседник", coach: "коуч", quiet: "тихий" },
  qualityMode: { economy: "экономно", auto: "авто", quality: "качество" },
} as const;

// ---------------------------------------------------------------------
// листы «поле — значение»
// ---------------------------------------------------------------------

export interface KeyValueField {
  key: string;
  label: string;
  importable: boolean;
}

export const PROFILE_FIELDS: readonly KeyValueField[] = [
  { key: "first_name", label: "Имя", importable: true },
  { key: "last_name", label: "Фамилия", importable: true },
  { key: "username", label: "Имя в Telegram", importable: false },
  { key: "language", label: "Язык", importable: false },
  { key: "timezone", label: "Часовой пояс", importable: true },
  { key: "city", label: "Город", importable: true },
  { key: "country_code", label: "Страна (код)", importable: true },
  { key: "since", label: "С Евой с", importable: false },
  { key: "response_mode", label: "Формат ответов", importable: true },
  { key: "agent_mode", label: "Режим Евы", importable: true },
  { key: "use_emoji", label: "Эмодзи", importable: true },
  { key: "heartbeat_enabled", label: "Ева пишет первой", importable: true },
  { key: "llm_quality_mode", label: "Качество ответов", importable: false },
];

export const NORTH_FIELDS: readonly KeyValueField[] = [
  { key: "desired_direction", label: "Куда я иду", importable: true },
  { key: "why_it_matters", label: "Почему это важно", importable: true },
  { key: "values", label: "Ценности", importable: true },
  { key: "conflicts", label: "Что мешает", importable: true },
  { key: "reduce_list", label: "Что сократить", importable: true },
  { key: "acceptable_cost", label: "Приемлемая цена", importable: true },
  { key: "unacceptable_cost", label: "Неприемлемая цена", importable: true },
  { key: "user_confirmed", label: "Подтверждено мной", importable: true },
];

/**
 * Разделы памяти Евы. Только то, что Ева знает о самом человеке:
 * `persona` и `therapeutic_framework` — устройство самой Евы, а не данные
 * человека, и в архив не попадают.
 */
export const MEMORY_FIELDS: readonly KeyValueField[] = [
  { key: "human", label: "Что Ева знает обо мне", importable: false },
  { key: "current_state", label: "Моё текущее состояние", importable: false },
];

export const ABOUT_FIELDS = {
  format: "Формат",
  version: "Версия формата",
  exportedAt: "Выгружено",
  zone: "Часовой пояс времени в файле",
} as const;

const keyValue = (value: string): readonly ArchiveColumn[] => [
  { key: "field", header: "Поле", kind: "text", width: 28 },
  { key: "value", header: value, kind: "longtext", width: 80 },
];

const created = (header = "Создано"): ArchiveColumn => ({ key: "created_at", header, kind: "datetime" });

// ---------------------------------------------------------------------
// листы
// ---------------------------------------------------------------------

export const SHEETS: readonly ArchiveSheet[] = [
  { id: "about", name: "О файле", importable: false, columns: keyValue("Значение") },
  { id: "profile", name: "Профиль", importable: true, columns: keyValue("Значение") },
  {
    id: "questionnaire", name: "Анкета", importable: true, columns: [
      { key: "field_key", header: "Код поля", kind: "text", width: 22 },
      { key: "title", header: "Вопрос", kind: "text", width: 30 },
      { key: "value", header: "Ответ", kind: "longtext" },
      { key: "status", header: "Статус", kind: "text", width: 16 },
      { key: "updated_at", header: "Обновлено", kind: "datetime" },
    ],
  },
  { id: "north", name: "Направление", importable: true, columns: keyValue("Значение") },
  {
    id: "goals", name: "Цели", importable: true, columns: [
      { key: "ref", header: "Ключ", kind: "text", width: 8 },
      { key: "parent", header: "Входит в цель", kind: "text", width: 10 },
      { key: "title", header: "Название", kind: "text", width: 36 },
      { key: "life_area", header: "Область жизни", kind: "text", width: 18 },
      { key: "horizon", header: "Горизонт", kind: "text", width: 14 },
      { key: "why_it_matters", header: "Зачем", kind: "longtext", width: 40 },
      { key: "result_artifact", header: "Результат", kind: "longtext", width: 40 },
      { key: "target_date", header: "Срок", kind: "date" },
      { key: "success_criteria", header: "Критерии успеха", kind: "longtext", width: 40 },
      { key: "minimum_version", header: "Минимальная версия", kind: "longtext", width: 30 },
      { key: "target_version", header: "Целевая версия", kind: "longtext", width: 30 },
      { key: "constraints", header: "Ограничения", kind: "longtext", width: 30 },
      { key: "learning_goal", header: "Чему научиться", kind: "longtext", width: 30 },
      { key: "review_condition", header: "Когда пересмотреть", kind: "text", width: 24 },
      { key: "stop_condition", header: "Когда остановиться", kind: "text", width: 24 },
      { key: "priority", header: "Приоритет (1–5)", kind: "int" },
      { key: "status", header: "Статус", kind: "text", width: 14 },
      { key: "vector_stage", header: "Этап", kind: "text", width: 16 },
      { key: "user_confirmed", header: "Подтверждена мной", kind: "bool" },
      created("Создана"),
      { key: "completed_at", header: "Завершена", kind: "datetime" },
    ],
  },
  {
    id: "results", name: "Результаты целей", importable: true, columns: [
      { key: "ref", header: "Ключ", kind: "text", width: 8 },
      { key: "goal", header: "Цель", kind: "text", width: 8 },
      { key: "goal_title", header: "Название цели", kind: "text", width: 28 },
      { key: "parent", header: "Входит в результат", kind: "text", width: 10 },
      { key: "title", header: "Название", kind: "text", width: 36 },
      { key: "result_artifact", header: "Артефакт", kind: "longtext", width: 30 },
      { key: "success_criteria", header: "Критерии успеха", kind: "longtext", width: 30 },
      { key: "minimum_version", header: "Минимальная версия", kind: "longtext", width: 30 },
      { key: "target_date", header: "Срок", kind: "date" },
      { key: "sort_order", header: "Порядок", kind: "int" },
      { key: "status", header: "Статус", kind: "text", width: 16 },
      { key: "is_checkpoint", header: "Контрольная точка", kind: "bool" },
      { key: "is_external", header: "Зависит от других", kind: "bool" },
      { key: "external_dependency", header: "От чего зависит", kind: "text", width: 24 },
      { key: "is_critical_path", header: "Критический путь", kind: "bool" },
      { key: "fallback_plan", header: "Запасной план", kind: "longtext", width: 30 },
      { key: "first_action", header: "Первое действие", kind: "text", width: 30 },
      { key: "progress_percent", header: "Прогресс, %", kind: "int" },
      { key: "completed_at", header: "Готов", kind: "datetime" },
    ],
  },
  {
    id: "tasks", name: "Задачи и напоминания", importable: true, columns: [
      { key: "title", header: "Название", kind: "text", width: 36 },
      { key: "description", header: "Описание", kind: "longtext", width: 40 },
      { key: "kind", header: "Вид", kind: "text", width: 14 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "priority", header: "Приоритет (1–5)", kind: "int" },
      { key: "due_at", header: "Срок", kind: "datetime" },
      { key: "remind_at", header: "Напомнить", kind: "datetime" },
      { key: "cron_expression", header: "Повтор (cron)", kind: "text", width: 14 },
      { key: "repeat_enabled", header: "Повторять", kind: "bool" },
      { key: "timezone", header: "Часовой пояс", kind: "text", width: 18 },
      { key: "reminders_enabled", header: "Напоминания включены", kind: "bool" },
      { key: "goal", header: "Цель", kind: "text", width: 8 },
      { key: "result", header: "Результат цели", kind: "text", width: 8 },
      { key: "goal_title", header: "Название цели", kind: "text", width: 28 },
      { key: "estimated_minutes", header: "Минут на задачу", kind: "int" },
      { key: "energy_required", header: "Нужно энергии (1–5)", kind: "int" },
      created("Создана"),
      { key: "completed_at", header: "Выполнена", kind: "datetime" },
    ],
  },
  {
    id: "journal", name: "Дневник", importable: true, columns: [
      { key: "local_date", header: "Дата", kind: "date" },
      { key: "title", header: "Заголовок", kind: "text", width: 28 },
      { key: "content", header: "Запись", kind: "longtext", width: 80 },
      { key: "mood", header: "Настроение", kind: "text", width: 12 },
      { key: "energy", header: "Энергия (1–10)", kind: "int" },
      { key: "people", header: "Люди", kind: "longtext", width: 24 },
      { key: "shared", header: "Обсуждалась с Евой", kind: "bool" },
      created("Создана"),
    ],
  },
  {
    id: "people", name: "Люди из дневника", importable: true, columns: [
      { key: "display_name", header: "Имя", kind: "text", width: 28 },
      { key: "relation", header: "Кем приходится", kind: "text", width: 28 },
    ],
  },
  {
    id: "notes", name: "Заметки", importable: true, columns: [
      { key: "title", header: "Заголовок", kind: "text", width: 32 },
      { key: "content", header: "Текст", kind: "longtext", width: 80 },
      { key: "category", header: "Категория", kind: "text", width: 16 },
      { key: "tags", header: "Теги", kind: "text", width: 20 },
      { key: "pinned", header: "Закреплена", kind: "bool" },
      { key: "entry_type", header: "Тип", kind: "text", width: 12 },
      created("Создана"),
    ],
  },
  {
    id: "checkins", name: "Самочувствие", importable: true, columns: [
      { key: "local_date", header: "Дата", kind: "date" },
      { key: "mood", header: "Настроение", kind: "text", width: 12 },
      { key: "energy", header: "Энергия (1–10)", kind: "int" },
      { key: "tension", header: "Напряжение (1–10)", kind: "int" },
      { key: "note", header: "Заметка", kind: "longtext", width: 50 },
    ],
  },
  {
    id: "budget", name: "Бюджет", importable: true, columns: [
      { key: "occurred_on", header: "Дата", kind: "date" },
      { key: "entry_type", header: "Тип", kind: "text", width: 10 },
      { key: "amount", header: "Сумма", kind: "number" },
      { key: "currency", header: "Валюта", kind: "text", width: 8 },
      { key: "category", header: "Категория", kind: "text", width: 18 },
      { key: "store", header: "Где", kind: "text", width: 18 },
      { key: "description", header: "Описание", kind: "text", width: 30 },
      { key: "payment_method", header: "Способ оплаты", kind: "text", width: 16 },
      { key: "quantity", header: "Количество", kind: "number" },
    ],
  },
  {
    id: "decisions", name: "Решения", importable: true, columns: [
      { key: "question", header: "Вопрос", kind: "longtext", width: 40 },
      { key: "options", header: "Варианты", kind: "longtext", width: 30 },
      { key: "facts", header: "Факты", kind: "longtext", width: 30 },
      { key: "assumptions", header: "Допущения", kind: "longtext", width: 30 },
      { key: "criteria", header: "Критерии", kind: "longtext", width: 30 },
      { key: "risks", header: "Риски", kind: "longtext", width: 30 },
      { key: "selected_option", header: "Выбор", kind: "text", width: 24 },
      { key: "confidence", header: "Уверенность, %", kind: "int" },
      { key: "reversible", header: "Обратимо", kind: "bool" },
      { key: "cheap_test", header: "Дешёвая проверка", kind: "text", width: 24 },
      { key: "review_at", header: "Пересмотреть", kind: "date" },
      { key: "actual_result", header: "Что вышло", kind: "longtext", width: 30 },
      { key: "status", header: "Статус", kind: "text", width: 14 },
      created(),
    ],
  },
  {
    id: "work_blocks", name: "Рабочие блоки", importable: false, columns: [
      { key: "goal", header: "Цель", kind: "text", width: 8 },
      { key: "result", header: "Результат цели", kind: "text", width: 8 },
      { key: "intention", header: "Намерение", kind: "longtext", width: 32 },
      { key: "first_physical_step", header: "Первый шаг", kind: "text", width: 28 },
      { key: "planned_start_at", header: "Начало по плану", kind: "datetime" },
      { key: "planned_minutes", header: "Минут по плану", kind: "int" },
      { key: "if_then_rule", header: "Если — то", kind: "text", width: 28 },
      { key: "completion_criterion", header: "Когда готово", kind: "text", width: 28 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "started_at", header: "Начат", kind: "datetime" },
      { key: "completed_at", header: "Завершён", kind: "datetime" },
      { key: "actual_minutes", header: "Минут на деле", kind: "int" },
      { key: "actual_result", header: "Что получилось", kind: "longtext", width: 30 },
      { key: "artifact", header: "Артефакт", kind: "text", width: 24 },
      { key: "obstacle", header: "Помеха", kind: "text", width: 24 },
      { key: "helpful_factor", header: "Что помогло", kind: "text", width: 24 },
      { key: "next_step", header: "Следующий шаг", kind: "text", width: 24 },
      { key: "energy_before", header: "Энергия до", kind: "int" },
      { key: "energy_after", header: "Энергия после", kind: "int" },
    ],
  },
  {
    id: "reviews", name: "Разборы целей", importable: false, columns: [
      { key: "goal", header: "Цель", kind: "text", width: 8 },
      { key: "review_type", header: "Вид разбора", kind: "text", width: 14 },
      { key: "fact", header: "Что было", kind: "longtext", width: 40 },
      { key: "system_signal", header: "Сигнал", kind: "longtext", width: 30 },
      { key: "changed_element", header: "Что меняем", kind: "text", width: 24 },
      { key: "next_small_step", header: "Следующий маленький шаг", kind: "text", width: 30 },
      created("Дата"),
    ],
  },
  {
    id: "strategies", name: "Стратегии", importable: false, columns: [
      { key: "goal", header: "Цель", kind: "text", width: 8 },
      { key: "title", header: "Название", kind: "text", width: 30 },
      { key: "description", header: "Описание", kind: "longtext", width: 50 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "uses_count", header: "Использована раз", kind: "int" },
      { key: "last_used_at", header: "Последний раз", kind: "datetime" },
    ],
  },
  {
    id: "experiments", name: "Эксперименты", importable: false, columns: [
      { key: "goal", header: "Цель", kind: "text", width: 8 },
      { key: "hypothesis", header: "Гипотеза", kind: "longtext", width: 36 },
      { key: "action_taken", header: "Что сделано", kind: "longtext", width: 30 },
      { key: "outcome", header: "Итог", kind: "longtext", width: 30 },
      { key: "lesson", header: "Вывод", kind: "longtext", width: 30 },
      { key: "next_experiment", header: "Следующий эксперимент", kind: "text", width: 30 },
      created("Дата"),
    ],
  },
  {
    id: "focus_days", name: "Фокус дня", importable: false, columns: [
      { key: "local_date", header: "Дата", kind: "date" },
      { key: "title", header: "Фокус", kind: "text", width: 36 },
      { key: "expected_result", header: "Ожидаемый результат", kind: "text", width: 36 },
      { key: "is_manual", header: "Выбран мной", kind: "bool" },
    ],
  },
  {
    id: "focus_sessions", name: "Фокус-сессии", importable: false, columns: [
      { key: "title", header: "Тема", kind: "text", width: 30 },
      { key: "planned_minutes", header: "Минут по плану", kind: "int" },
      { key: "actual_minutes", header: "Минут на деле", kind: "int" },
      { key: "actual_result", header: "Результат", kind: "longtext", width: 36 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "started_at", header: "Начата", kind: "datetime" },
      { key: "completed_at", header: "Завершена", kind: "datetime" },
    ],
  },
  {
    id: "windows", name: "Окна инициативы", importable: false, columns: [
      { key: "start", header: "С", kind: "text", width: 8 },
      { key: "end", header: "До", kind: "text", width: 8 },
      { key: "weekdays", header: "Дни недели", kind: "text", width: 20 },
      { key: "enabled", header: "Включено", kind: "bool" },
      { key: "label", header: "Подпись", kind: "text", width: 24 },
    ],
  },
  {
    id: "conversations", name: "Диалоги", importable: false, columns: [
      { key: "title", header: "Название", kind: "text", width: 32 },
      { key: "purpose", header: "Назначение", kind: "text", width: 16 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "message_count", header: "Сообщений", kind: "int" },
      { key: "started_at", header: "Начат", kind: "datetime" },
      { key: "last_message_at", header: "Последнее сообщение", kind: "datetime" },
      { key: "archived_at", header: "В архиве с", kind: "datetime" },
    ],
  },
  {
    id: "documents", name: "Документы", importable: false, columns: [
      { key: "name", header: "Файл", kind: "text", width: 36 },
      { key: "mime", header: "Тип", kind: "text", width: 24 },
      { key: "size_kb", header: "Размер, КБ", kind: "number" },
      { key: "status", header: "Состояние", kind: "text", width: 14 },
      { key: "chunk_count", header: "Фрагментов", kind: "int" },
      { key: "source", header: "Откуда", kind: "text", width: 14 },
      created("Загружен"),
    ],
  },
  {
    id: "research", name: "Исследования", importable: false, columns: [
      { key: "query", header: "Запрос", kind: "longtext", width: 40 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "summary", header: "Итог", kind: "longtext", width: 60 },
      created("Начато"),
      { key: "completed_at", header: "Завершено", kind: "datetime" },
    ],
  },
  {
    id: "subscriptions", name: "Подписка", importable: false, columns: [
      { key: "plan", header: "Тариф", kind: "text", width: 16 },
      { key: "status", header: "Статус", kind: "text", width: 14 },
      { key: "source", header: "Откуда", kind: "text", width: 14 },
      { key: "started_at", header: "Начало", kind: "datetime" },
      { key: "current_period_end", header: "Действует до", kind: "datetime" },
      { key: "canceled_at", header: "Отменена", kind: "datetime" },
    ],
  },
  {
    id: "payments", name: "Платежи", importable: false, columns: [
      { key: "paid_at", header: "Дата", kind: "datetime" },
      { key: "amount", header: "Сумма", kind: "number" },
      { key: "currency", header: "Валюта", kind: "text", width: 8 },
      { key: "status", header: "Статус", kind: "text", width: 12 },
      { key: "description", header: "Описание", kind: "text", width: 36 },
    ],
  },
  {
    id: "tests", name: "Тесты", importable: false, columns: [
      { key: "test_key", header: "Тест", kind: "text", width: 24 },
      { key: "test_version", header: "Версия", kind: "text", width: 8 },
      { key: "scores", header: "Баллы", kind: "longtext", width: 40 },
      { key: "summary", header: "Итог", kind: "longtext", width: 60 },
      { key: "started_at", header: "Начат", kind: "datetime" },
      { key: "completed_at", header: "Завершён", kind: "datetime" },
    ],
  },
  {
    id: "memory", name: "Память Евы", importable: false, columns: [
      { key: "field", header: "Раздел", kind: "text", width: 28 },
      { key: "value", header: "Содержание", kind: "longtext", width: 100 },
    ],
  },
];

export const SHEET_BY_ID = new Map(SHEETS.map((sheet) => [sheet.id, sheet]));

export function sheet(id: SheetId): ArchiveSheet {
  return SHEET_BY_ID.get(id)!;
}

/** Заголовок столбца-продолжения: по нему загрузка склеивает текст обратно. */
export function continuationHeader(header: string, part: number): string {
  return `${header} (продолжение ${part})`;
}

export const CONTINUATION = /^(.*\S)\s+\(продолжение\s+(\d{1,3})\)$/u;

/**
 * Столбцы листа так, как они лежат в файле: `parts` — сколько частей
 * нужно каждому столбцу (по самому длинному значению), по умолчанию одна.
 */
export function physicalColumns(
  definition: ArchiveSheet,
  parts: ReadonlyMap<string, number> = new Map(),
): Array<{ column: ArchiveColumn; part: number; header: string }> {
  return definition.columns.flatMap((column) => Array.from(
    { length: Math.max(parts.get(column.key) ?? 1, 1) },
    (_, part) => ({ column, part, header: part === 0 ? column.header : continuationHeader(column.header, part) }),
  ));
}
