/**
 * Классы данных и сроки их хранения.
 *
 * Политика — не число в коде и не константа в скрипте очистки: она
 * живёт в Config Service вместе с остальными настройками, потому что там
 * уже есть ровно то, что требует шаг 10, — типы, границы, версия, аудит
 * и откат. Второй системы политик не заводится (требование «СНАЧАЛА
 * ПРОВЕРЬ»).
 *
 * Здесь — список классов, их умолчания и границы, а также то, ЧТО
 * означает удаление для каждого класса. Разница принципиальная:
 *
 *   delete  — строки удаляются;
 *   redact  — содержание вычищается, а ключ идемпотентности, статус и
 *             аудит остаются (требование 5: редактирование не должно
 *             ломать защиту от дублей);
 *   manual  — автоматического удаления нет вовсе. Каноническая память и
 *             сохранённые пользователем документы удаляются только по
 *             его решению, и «срок хранения» для них — это ноль правил,
 *             а не большое число;
 *   external — данные лежат в чужой системе (Langfuse). Мы храним
 *             политику и предъявляем её в отчёте, но удаляем не мы, и
 *             делать вид, что удаляем, нельзя.
 */

export type RetentionAction = "delete" | "redact" | "manual" | "external";

export interface RetentionClass {
  code: string;
  title: string;
  action: RetentionAction;
  /** Ключ настройки в Config Service. Пусто — срок не настраивается. */
  settingKey: string | null;
  /** Умолчание в днях. `null` — срока нет по существу. */
  defaultDays: number | null;
  minDays?: number;
  maxDays?: number;
  /** Что именно затрагивается. Показывается в предпросмотре. */
  targets: string;
}

/**
 * Классы данных.
 *
 * Порядок — от самого короткого срока к самому длинному: так таблица
 * читается как шкала, а не как список.
 */
export const RETENTION_CLASSES: readonly RetentionClass[] = [
  {
    code: "app_logs",
    title: "Логи приложения и debug-трассы",
    action: "delete",
    settingKey: "retention.app_logs_days",
    defaultDays: 7,
    minDays: 1,
    maxDays: 30,
    targets: "журналы процессов и отладочные трассы",
  },
  {
    code: "telegram_payload",
    title: "Сырой payload Telegram inbox и outbox",
    action: "redact",
    settingKey: "retention.telegram_payload_days",
    defaultDays: 7,
    minDays: 1,
    maxDays: 30,
    targets: "telegram_updates.payload, telegram_outbox.payload",
  },
  {
    code: "media_temp",
    title: "Временные голосовые, изображения и документы",
    action: "delete",
    settingKey: "retention.media_temp_days",
    defaultDays: 7,
    minDays: 1,
    maxDays: 30,
    targets: "временные файлы media-service и производные",
  },
  {
    code: "telegram_idempotency",
    title: "Метаданные идемпотентности без содержания",
    action: "delete",
    settingKey: "retention.telegram_idempotency_days",
    defaultDays: 30,
    minDays: 7,
    maxDays: 180,
    targets: "строки telegram_updates и telegram_outbox без payload",
  },
  {
    code: "langfuse_metadata",
    title: "Метаданные Langfuse",
    action: "external",
    settingKey: "retention.langfuse_metadata_days",
    defaultDays: 30,
    minDays: 1,
    maxDays: 90,
    targets: "проект Langfuse; удаление настраивается на его стороне",
  },
  {
    code: "dead_letters",
    title: "Безопасные метаданные dead-letter",
    action: "delete",
    settingKey: "retention.dead_letters_days",
    defaultDays: 90,
    minDays: 30,
    maxDays: 365,
    targets: "job_dead_letters",
  },
  {
    code: "metrics_aggregated",
    title: "Агрегированные метрики без содержания",
    action: "delete",
    settingKey: "retention.metrics_days",
    defaultDays: 365,
    minDays: 365,
    maxDays: 1095,
    targets: "job_mirror_samples, retention_runs, агрегаты наблюдаемости",
  },
  {
    code: "canonical_memory",
    title: "Каноническая память и бизнес-записи",
    action: "manual",
    settingKey: null,
    defaultDays: null,
    targets: "goals, tasks, записи дневника — удаляются по решению человека",
  },
  {
    code: "user_documents",
    title: "Документы, сохранённые пользователем",
    action: "manual",
    settingKey: null,
    defaultDays: null,
    targets: "сохранённые файлы — не подпадают под правило временных",
  },
];

export const RETENTION_BY_CODE = new Map(RETENTION_CLASSES.map((item) => [item.code, item]));

/** Действующие сроки: умолчание класса, если настройка не задана. */
export function effectivePolicies(
  settings: Record<string, unknown>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of RETENTION_CLASSES) {
    if (item.defaultDays === null) continue;
    const raw = item.settingKey ? settings[item.settingKey] : undefined;
    const days = typeof raw === "number" && Number.isSafeInteger(raw) ? raw : item.defaultDays;
    const clamped = Math.min(
      item.maxDays ?? days,
      Math.max(item.minDays ?? days, days),
    );
    result[item.code] = clamped * 24 * 3_600;
  }
  return result;
}

/**
 * Сколько уже созданные резервные копии продолжают хранить удалённое.
 *
 * Требование 6 шага 10: мгновенное физическое удаление из зашифрованных
 * копий не обещается. Это число попадает в отчёт об удалении и экспорте,
 * чтобы обещание совпадало с действительностью.
 */
export const BACKUP_ROTATION_DAYS = 30;
