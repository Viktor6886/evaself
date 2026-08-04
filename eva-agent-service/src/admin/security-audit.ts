/**
 * Минимальный контракт доступа к базе.
 *
 * admin-api работает с pg.Pool напрямую, рантайм — со своей обёрткой
 * Database. Обе подходят под этот интерфейс, и сервису не нужно знать,
 * какая из них перед ним.
 */
export interface QueryableDatabase {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Security Audit — список находок по действующей конфигурации.
 *
 * Смысл раздела в том, что небезопасная настройка обычно не проявляется
 * как поломка: стек работает, тесты зелёные, а публичная поверхность
 * открыта. Поэтому каждая проверка называет КОНКРЕТНЫЙ параметр, а не
 * «раздел безопасности».
 *
 * Правила, которым подчиняются проверки:
 *
 *   • ни одна находка не содержит значения секрета — только имя
 *     параметра и вердикт;
 *   • «не знаем» не превращается в «всё хорошо»: недоступная проверка
 *     возвращает уровень unknown, а не ok;
 *   • уровень отражает последствие, а не сложность починки.
 */

export type SecurityFindingLevel = "critical" | "high" | "medium" | "low" | "unknown";

export interface SecurityFinding {
  id: string;
  level: SecurityFindingLevel;
  title: string;
  /** Конкретный параметр: переменная окружения, поле compose, таблица. */
  parameter: string;
  detail: string;
}

export interface SecurityAuditReport {
  generated_at: string;
  findings: SecurityFinding[];
  summary: Record<SecurityFindingLevel, number>;
}

export interface SecurityAuditEnvironment {
  env: NodeJS.ProcessEnv;
  db: QueryableDatabase;
  now?: () => Date;
}

const DEFAULT_CREDENTIALS = new Set([
  "admin",
  "password",
  "changeme",
  "evaself",
  "postgres",
  "secret",
  "test",
]);

/** Значение-заглушка: длина есть, а энтропии нет. */
function looksLikePlaceholder(value: string): boolean {
  const clean = value.trim().toLowerCase();
  if (!clean) return true;
  if (DEFAULT_CREDENTIALS.has(clean)) return true;
  if (/^(changeme|placeholder|example|dummy|todo|xxx+)/.test(clean)) return true;
  // Одинаковые символы или одно повторяющееся слово.
  if (new Set(clean).size <= 4) return true;
  return false;
}

export class SecurityAuditService {
  constructor(private readonly options: SecurityAuditEnvironment) {}

  async run(): Promise<SecurityAuditReport> {
    const env = this.options.env;
    const findings: SecurityFinding[] = [];

    // -----------------------------------------------------------------
    // 1. Пустые и дефолтные учётные данные
    // -----------------------------------------------------------------
    const requiredSecrets: Array<[string, SecurityFindingLevel, string]> = [
      ["EVA_AGENT_API_KEY", "critical", "внутренний API рантайма открыт без ключа"],
      ["MEDIA_SERVICE_TOKEN", "critical", "media-service тратит токен бота и платные ключи ASR/TTS"],
      ["EVA_TELEGRAM_WEBHOOK_SECRET", "high", "webhook принимает обновления без сверки секрета"],
      ["LLM_CONFIG_ENCRYPTION_KEY", "critical", "конфигурация провайдеров хранится без шифрования"],
      ["EVA_ROUTER_API_KEY", "high", "LLM Router доступен без ключа"],
      ["VALKEY_PASSWORD", "high", "Valkey принимает подключения без пароля"],
    ];
    for (const [name, level, detail] of requiredSecrets) {
      const value = (env[name] ?? "").trim();
      if (!value) {
        findings.push({
          id: `secret.missing.${name}`,
          level,
          title: "Ключ не задан",
          parameter: name,
          detail,
        });
      } else if (looksLikePlaceholder(value)) {
        findings.push({
          id: `secret.weak.${name}`,
          level,
          title: "Значение похоже на заглушку",
          parameter: name,
          detail: `${detail}. Значение выглядит как значение по умолчанию.`,
        });
      }
    }

    // -----------------------------------------------------------------
    // 2. Небезопасные настройки публичных поверхностей
    // -----------------------------------------------------------------
    const maxAge = Number.parseInt(env.EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS ?? "", 10);
    if (Number.isFinite(maxAge) && maxAge > 600) {
      findings.push({
        id: "webapp.init_data_window",
        level: "medium",
        title: "Окно приёма initData шире допустимого",
        parameter: "EVA_TELEGRAM_WEBAPP_MAX_AGE_SECONDS",
        detail:
          `В .env указано ${maxAge} с. Код зажимает значение до 600 с, поэтому`
          + " поверхность не расширена, но .env вводит в заблуждение.",
      });
    }

    for (const [name, level] of [
      ["EVA_PUBLIC_RATE_LIMIT_PER_IP", "high"],
      ["EVA_PUBLIC_RATE_LIMIT_PER_USER", "high"],
      ["EVA_WEBHOOK_RATE_LIMIT_PER_IP", "high"],
    ] as Array<[string, SecurityFindingLevel]>) {
      const raw = env[name];
      if (raw !== undefined && Number.parseInt(raw, 10) === 0) {
        findings.push({
          id: `ratelimit.disabled.${name}`,
          level,
          title: "Лимит запросов отключён",
          parameter: name,
          detail: "Значение 0 снимает ограничение на публичной поверхности.",
        });
      }
    }

    // -----------------------------------------------------------------
    // 3. Окружение и режим
    // -----------------------------------------------------------------
    const evaEnv = (env.EVA_ENV ?? "").trim().toLowerCase();
    if (evaEnv && evaEnv !== "production") {
      findings.push({
        id: "env.not_production",
        level: "medium",
        title: "Установка работает не в режиме production",
        parameter: "EVA_ENV",
        detail:
          `EVA_ENV=${evaEnv}. В этом режиме часть проверок ослаблена —`
          + " например media-service стартует с пустым токеном.",
      });
    }

    if ((env.ACME_STAGING ?? "") === "1") {
      findings.push({
        id: "tls.staging_ca",
        level: "medium",
        title: "Сертификаты выдаёт staging CA",
        parameter: "ACME_STAGING",
        detail: "Браузеры не доверяют таким сертификатам.",
      });
    }

    // -----------------------------------------------------------------
    // 4. Отсутствующие ключи шифрования и мастер-ключ
    // -----------------------------------------------------------------
    if (!(env.EVA_SECRETS_MASTER_KEY_FILE ?? "").trim()) {
      findings.push({
        id: "secret_store.master_key_path",
        level: "high",
        title: "Путь к мастер-ключу Secret Store не задан",
        parameter: "EVA_SECRETS_MASTER_KEY_FILE",
        detail:
          "Без него backup шифруется ключом по умолчанию, а restore ищет его"
          + " в /etc/evaself/secrets-master-key.",
      });
    }

    // -----------------------------------------------------------------
    // 5. Состояние из базы: аудит, политики хранения, агенты
    // -----------------------------------------------------------------
    findings.push(...(await this.databaseFindings()));

    return this.report(findings);
  }

  private async databaseFindings(): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];

    // Аудит административных действий: пустой журнал при существующих
    // администраторах означает, что записи не доходят.
    try {
      const { rows } = await this.options.db.query<{ admins: string; entries: string }>(
        `SELECT (SELECT count(*) FROM admin_users WHERE status = 'active') AS admins,
                (SELECT count(*) FROM admin_audit_log) AS entries`,
      );
      const admins = Number(rows[0]?.admins ?? 0);
      const entries = Number(rows[0]?.entries ?? 0);
      if (admins > 0 && entries === 0) {
        findings.push({
          id: "audit.empty",
          level: "high",
          title: "Журнал административных действий пуст",
          parameter: "admin_audit_log",
          detail: `Активных администраторов: ${admins}, записей аудита нет.`,
        });
      }
    } catch (error) {
      findings.push(this.unknownFinding("audit.unreadable", "admin_audit_log", error));
    }

    // Администратор, у которого пароль ни разу не менялся с момента
    // создания, всё ещё сидит на bootstrap-пароле из .env. Признак берётся
    // из существующих колонок: отдельного флага в схеме нет, а заводить
    // его — не дело этого шага.
    try {
      const { rows } = await this.options.db.query<{ count: string }>(
        `SELECT count(*) AS count FROM admin_users
          WHERE status = 'active' AND password_changed_at <= created_at`,
      );
      const pending = Number(rows[0]?.count ?? 0);
      if (pending > 0) {
        findings.push({
          id: "admin.bootstrap_password",
          level: "high",
          title: "Пароль администратора не менялся с момента создания",
          parameter: "admin_users.password_changed_at",
          detail:
            `Таких учётных записей: ${pending}. Скорее всего действует`
            + " EVA_ADMIN_BOOTSTRAP_PASSWORD из .env.",
        });
      }
    } catch (error) {
      findings.push(
        this.unknownFinding("admin.unreadable", "admin_users", error),
      );
    }

    // Дрейф политик хранения: включённая политика без единого применения.
    try {
      const { rows } = await this.options.db.query<{ count: string }>(
        `SELECT count(*) AS count FROM secret_records WHERE status = 'active'`,
      );
      const secrets = Number(rows[0]?.count ?? 0);
      if (secrets === 0) {
        findings.push({
          id: "secret_store.empty",
          level: "low",
          title: "Secret Store пуст",
          parameter: "secret_records",
          detail:
            "Секреты берутся только из окружения. Ротация через панель для них"
            + " недоступна.",
        });
      }
    } catch (error) {
      findings.push(
        this.unknownFinding("secret_store.unreadable", "secret_records", error),
      );
    }

    return findings;
  }

  /**
   * Недоступная проверка — это «не знаем», а не «всё хорошо».
   *
   * Текст ошибки не попадает в находку: он может содержать фрагмент
   * запроса или значения.
   */
  private unknownFinding(
    id: string,
    parameter: string,
    error: unknown,
  ): SecurityFinding {
    return {
      id,
      level: "unknown",
      title: "Проверку выполнить не удалось",
      parameter,
      detail: `Причина: ${error instanceof Error ? error.name : "неизвестна"}.`,
    };
  }

  private report(findings: SecurityFinding[]): SecurityAuditReport {
    const order: Record<SecurityFindingLevel, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
      unknown: 4,
    };
    const sorted = [...findings].sort(
      (left, right) => order[left.level] - order[right.level]
        || left.id.localeCompare(right.id),
    );
    const summary: Record<SecurityFindingLevel, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    };
    for (const finding of sorted) summary[finding.level] += 1;
    return {
      generated_at: (this.options.now?.() ?? new Date()).toISOString(),
      findings: sorted,
      summary,
    };
  }
}
