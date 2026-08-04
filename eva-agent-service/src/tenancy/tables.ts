/**
 * Реестр таблиц, принадлежащих пользователю.
 *
 * Это единственный список, по которому проходит проверка границы
 * арендатора. Таблица, которой здесь нет, считается общей (настройки,
 * провайдеры, реестры) и обращения к ней не ограничиваются.
 *
 * Столбцы перечислены в порядке предпочтения: первый — канонический
 * ключ владельца, остальные допустимы, потому что уже используются
 * существующими запросами (например `users` адресуется и по `id`, и по
 * `telegram_id`).
 *
 * Новую пользовательскую таблицу обязан добавлять сюда тот шаг, который
 * её создаёт: тест `tenant-isolation.test.ts` сверяет реестр со схемой в
 * `postgres/migrations` и падает, если появилась таблица со столбцом
 * `user_id`, о которой реестр не знает.
 */

/** Столбец, по значению которого сверяется Telegram-идентификатор. */
export const TELEGRAM_COLUMNS = new Set(["telegram_id", "telegram_user_id"]);

export const TENANT_TABLES: Readonly<Record<string, readonly string[]>> = {
  admin_user_notes: ["user_id"],
  agent_conversations: ["user_id"],
  agent_links: ["user_id"],
  budget_entries: ["user_id"],
  conversation_highlights: ["user_id"],
  crisis_events: ["user_id"],
  daily_focus_selections: ["user_id"],
  eva_decisions: ["user_id"],
  eva_focus_sessions: ["user_id"],
  eva_notes: ["user_id"],
  goal_dependencies: ["user_id"],
  goal_recommendations: ["user_id"],
  goal_results: ["user_id"],
  goal_reviews: ["user_id"],
  goals: ["user_id"],
  heartbeat_state: ["user_id"],
  learning_attempts: ["user_id"],
  llm_requests: ["user_id"],
  memory_edges: ["user_id"],
  memory_nodes: ["user_id"],
  notifications: ["user_id"],
  onboarding_fields: ["user_id"],
  partner_analysis_links: ["user_id", "partner_user_id"],
  payment_intents: ["user_id"],
  payments: ["user_id"],
  referrals: ["referrer_user_id", "invited_user_id"],
  subscriptions: ["user_id"],
  task_events: ["user_id"],
  tasks: ["user_id"],
  telegram_outbox: ["user_id"],
  telegram_updates: ["user_id", "telegram_user_id"],
  test_results: ["user_id"],
  usage_counters: ["user_id"],
  user_checkins: ["user_id"],
  user_north: ["user_id"],
  user_preferences: ["user_id"],
  user_strategies: ["user_id"],
  users: ["id", "telegram_id"],
  work_blocks: ["user_id"],
  // Представления читаются как обычные пользовательские источники.
  v_agent_runtime: ["telegram_id"],
  v_crisis_open: ["user_id", "telegram_id"],
  v_quota_status: ["user_id", "telegram_id"],
  v_user_overview: ["id", "telegram_id"],
};

/**
 * Таблицы, где перечисленные столбцы указывают на РАЗНЫХ людей. Для них
 * нельзя считать, что ограничение по одному столбцу ограничивает строку
 * по другому: приглашение связывает двоих, и это разные владельцы.
 */
export const MULTI_PARTY_TABLES = new Set(["partner_analysis_links", "referrals"]);

/**
 * Таблицы со столбцом `user_id`, который указывает НЕ на пользователя
 * Евы. `admin_sessions.user_id` — это оператор панели из `admin_users`;
 * его изоляция обеспечивается ролями и сессиями административного API,
 * а не границей арендатора. Список закрытый и сверяется тестом.
 */
export const NON_TENANT_USER_ID_TABLES = new Set(["admin_sessions"]);

export function tenantColumns(table: string): readonly string[] | null {
  return Object.hasOwn(TENANT_TABLES, table) ? TENANT_TABLES[table]! : null;
}

export function isTenantTable(table: string): boolean {
  return tenantColumns(table) !== null;
}
