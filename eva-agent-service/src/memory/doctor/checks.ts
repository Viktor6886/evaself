/**
 * Проверки Memory Doctor.
 *
 * Каждая проверка — один запрос и одно правило превращения строки в
 * находку. Диагностика держится отдельно от оркестровки по трём
 * причинам: набор проверок растёт, его версия попадает в отчёт, а
 * каждая строка обязана называть своего арендатора — здесь это видно
 * глазом и ловится `scripts/ci/assert-tenant-scope.py`.
 *
 * Тег с именем проверки в начале запроса — не украшение: по нему
 * прогон отличает запросы друг от друга в журналах и в тестах, где
 * база подменена.
 *
 * Проверка ничего не исправляет и ничего не пишет. Предложение —
 * это описание намерения, которое исполнит человек (требования 4 и 6
 * шага 17).
 */

export const DOCTOR_CHECKS_VERSION = 1;

/**
 * Порог объёма проекции блока в знаках. Бюджет памяти из `CLAUDE.md` —
 * 2500 токенов на все шесть блоков; здесь он огрублён до знаков, потому
 * что точный счёт токенов принадлежит сборщику контекста, а не
 * диагностике. Константа, а не параметр запроса: порог принадлежит
 * набору проверок и попадает в отчёт вместе с его версией.
 */
export const CORE_MEMORY_CHARACTER_BUDGET = 2_400;

export const DOCTOR_CHECK_IDS = [
  "duplicate_nodes",
  "semantic_duplicates",
  "contradictions",
  "stale_facts",
  "wrong_version_for_time",
  "low_confidence",
  "missing_evidence",
  "stale_goals",
  "oversized_core_memory",
  "privacy_mismatch",
  "lost_graph_links",
  "orphan_embeddings",
  "letta_divergence",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

export type DoctorSeverity = "info" | "warning" | "critical";

export type DoctorActionType =
  | "merge_duplicate"
  | "request_confirmation"
  | "mark_forgotten"
  | "raise_privacy"
  | "archive_edge"
  | "resync_block";

export interface DoctorProposal {
  actionType: DoctorActionType;
  nodeId: number | null;
  /** Что именно предлагается сделать — словами, без сырого текста. */
  detail: Record<string, string | number | null>;
}

export interface DoctorFinding {
  id: string;
  check: DoctorCheckId;
  severity: DoctorSeverity;
  subject: { kind: "node" | "edge" | "goal" | "block" | "embedding"; ids: string[] };
  /**
   * Доказательство: ссылки на конкретные записи и ровно те величины,
   * из которых следует вывод. Сырой пользовательский текст сюда
   * попадает только тогда, когда он и есть доказательство (совпавшие
   * заголовки), и обрезается до `EXCERPT_LIMIT`.
   */
  evidence: Record<string, string | number | null>;
  proposal: DoctorProposal | null;
}

export interface DoctorCheck {
  id: DoctorCheckId;
  title: string;
  severity: DoctorSeverity;
  /** Таблица, без которой проверка неприменима, а не пуста. */
  dependsOn?: string;
  sql: string;
  finding: (row: Record<string, unknown>) => DoctorFinding;
}

/** Сколько знаков пользовательского текста допускается в доказательстве. */
export const EXCERPT_LIMIT = 120;

export function excerpt(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, EXCERPT_LIMIT);
}

const num = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string => String(value ?? "");

/**
 * $1 — арендатор, $2 — предел строк на проверку. Предел приходит из
 * бюджета прогона: диагностика не имеет права прочитать всю память
 * пользователя целиком ради одного отчёта.
 */
export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  {
    id: "duplicate_nodes",
    title: "Дубликаты записей",
    severity: "warning",
    sql: `/* doctor:duplicate_nodes */
      SELECT n.node_type,
             lower(n.title) AS normalized_title,
             count(*)::int AS copies,
             (array_agg(n.id ORDER BY n.id))[1] AS keep_node_id,
             array_agg(n.id ORDER BY n.id) AS node_ids,
             min(n.title) AS sample_title
        FROM memory_nodes n
       WHERE n.user_id = $1
         AND n.status IN ('active', 'candidate')
       GROUP BY n.node_type, lower(n.title)
      HAVING count(*) > 1
       ORDER BY count(*) DESC
       LIMIT $2`,
    finding: (row) => ({
      id: `duplicate_nodes:${text(row.node_type)}:${text(row.keep_node_id)}`,
      check: "duplicate_nodes",
      severity: "warning",
      subject: { kind: "node", ids: idList(row.node_ids) },
      evidence: {
        node_type: text(row.node_type),
        copies: num(row.copies),
        // Совпавший заголовок и есть доказательство дубля.
        title: excerpt(row.sample_title),
      },
      proposal: {
        actionType: "merge_duplicate",
        nodeId: num(row.keep_node_id),
        detail: { keep_node_id: num(row.keep_node_id), copies: num(row.copies) },
      },
    }),
  },
  {
    id: "semantic_duplicates",
    title: "Семантически одинаковые записи",
    severity: "info",
    // Похожесть здесь триграммная. Векторное сходство появляется
    // шагом 18 и подключается к этой же проверке — заводить ради него
    // второй поисковый контур запрещено (инвариант 14).
    sql: `/* doctor:semantic_duplicates */
      SELECT a.id AS node_id,
             b.id AS other_node_id,
             a.node_type,
             a.title AS sample_title,
             round(similarity(a.title, b.title)::numeric, 3) AS score
        FROM memory_nodes a
        JOIN memory_nodes b
          ON b.user_id = a.user_id
         AND b.node_type = a.node_type
         AND b.id > a.id
         AND lower(b.title) <> lower(a.title)
         AND similarity(a.title, b.title) >= 0.62
       WHERE a.user_id = $1
         AND a.status IN ('active', 'candidate')
         AND b.status IN ('active', 'candidate')
       ORDER BY score DESC
       LIMIT $2`,
    finding: (row) => ({
      id: `semantic_duplicates:${text(row.node_id)}:${text(row.other_node_id)}`,
      check: "semantic_duplicates",
      severity: "info",
      subject: { kind: "node", ids: [text(row.node_id), text(row.other_node_id)] },
      evidence: {
        node_type: text(row.node_type),
        score: num(row.score),
        title: excerpt(row.sample_title),
      },
      proposal: {
        actionType: "merge_duplicate",
        nodeId: num(row.node_id),
        detail: { keep_node_id: num(row.node_id), other_node_id: num(row.other_node_id) },
      },
    }),
  },
  {
    id: "contradictions",
    title: "Противоречия",
    severity: "critical",
    // Конфликты уже находит запись факта шага 15. Doctor их не
    // пересчитывает — он показывает те, что остались неразрешёнными.
    sql: `/* doctor:contradictions */
      SELECT c.id AS conflict_id, c.node_id, c.fact_key, c.kind, c.significance, c.status
        FROM memory_conflicts c
       WHERE c.user_id = $1
         AND c.status IN ('open', 'awaiting_user')
       ORDER BY CASE c.significance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                c.created_at DESC
       LIMIT $2`,
    finding: (row) => ({
      id: `contradictions:${text(row.conflict_id)}`,
      check: "contradictions",
      severity: text(row.significance) === "high" ? "critical" : "warning",
      subject: { kind: "node", ids: [text(row.node_id)] },
      evidence: {
        conflict_id: num(row.conflict_id),
        fact_key: text(row.fact_key),
        kind: text(row.kind),
        significance: text(row.significance),
      },
      proposal: {
        actionType: "request_confirmation",
        nodeId: num(row.node_id),
        detail: { conflict_id: num(row.conflict_id), reason: text(row.kind) },
      },
    }),
  },
  {
    id: "stale_facts",
    title: "Устаревшие факты",
    severity: "warning",
    sql: `/* doctor:stale_facts */
      SELECT v.node_id, v.fact_key, v.id AS version_id,
             extract(epoch FROM (now() - v.observed_at))::bigint / 86400 AS age_days
        FROM memory_node_versions v
       WHERE v.user_id = $1
         AND v.status = 'active'
         AND v.valid_to IS NULL
         AND v.observed_at < now() - interval '365 days'
       ORDER BY v.observed_at
       LIMIT $2`,
    finding: (row) => ({
      id: `stale_facts:${text(row.version_id)}`,
      check: "stale_facts",
      severity: "warning",
      subject: { kind: "node", ids: [text(row.node_id)] },
      evidence: {
        version_id: num(row.version_id),
        fact_key: text(row.fact_key),
        age_days: num(row.age_days),
      },
      proposal: {
        actionType: "request_confirmation",
        nodeId: num(row.node_id),
        detail: { version_id: num(row.version_id), age_days: num(row.age_days) },
      },
    }),
  },
  {
    id: "wrong_version_for_time",
    title: "Неверная версия по времени",
    severity: "critical",
    // Две живые версии одного факта с пересекающимися периодами — это
    // «на дату» с двумя ответами. Само по себе это не ошибка данных
    // пользователя, а ошибка записи, и чинить её угадыванием нельзя.
    sql: `/* doctor:wrong_version_for_time */
      SELECT a.node_id, a.fact_key, a.id AS version_id, b.id AS other_version_id,
             a.valid_from, a.valid_to
        FROM memory_node_versions a
        JOIN memory_node_versions b
          ON b.user_id = a.user_id
         AND b.node_id = a.node_id
         AND b.fact_key = a.fact_key
         AND b.id > a.id
         AND b.status IN ('active', 'candidate')
         AND a.valid_from < COALESCE(b.valid_to, 'infinity'::timestamptz)
         AND b.valid_from < COALESCE(a.valid_to, 'infinity'::timestamptz)
       WHERE a.user_id = $1
         AND a.status IN ('active', 'candidate')
       ORDER BY a.node_id
       LIMIT $2`,
    finding: (row) => ({
      id: `wrong_version_for_time:${text(row.version_id)}:${text(row.other_version_id)}`,
      check: "wrong_version_for_time",
      severity: "critical",
      subject: { kind: "node", ids: [text(row.node_id)] },
      evidence: {
        fact_key: text(row.fact_key),
        version_id: num(row.version_id),
        other_version_id: num(row.other_version_id),
      },
      proposal: {
        actionType: "request_confirmation",
        nodeId: num(row.node_id),
        detail: { version_id: num(row.version_id), other_version_id: num(row.other_version_id) },
      },
    }),
  },
  {
    id: "low_confidence",
    title: "Слишком низкая уверенность",
    severity: "info",
    sql: `/* doctor:low_confidence */
      SELECT n.id AS node_id, n.node_type, n.confidence, n.status
        FROM memory_nodes n
       WHERE n.user_id = $1
         AND n.status IN ('active', 'candidate')
         AND n.confidence < 0.4
       ORDER BY n.confidence
       LIMIT $2`,
    finding: (row) => ({
      id: `low_confidence:${text(row.node_id)}`,
      check: "low_confidence",
      severity: "info",
      subject: { kind: "node", ids: [text(row.node_id)] },
      evidence: {
        node_type: text(row.node_type),
        confidence: num(row.confidence),
        status: text(row.status),
      },
      proposal: {
        actionType: "request_confirmation",
        nodeId: num(row.node_id),
        detail: { confidence: num(row.confidence) },
      },
    }),
  },
  {
    id: "missing_evidence",
    title: "Факты без доказательств",
    severity: "warning",
    sql: `/* doctor:missing_evidence */
      SELECT n.id AS node_id, n.node_type, n.source_type
        FROM memory_nodes n
       WHERE n.user_id = $1
         AND n.status IN ('active', 'candidate')
         AND NOT EXISTS (
           SELECT 1 FROM memory_evidence e
            WHERE e.user_id = n.user_id AND e.node_id = n.id
         )
       ORDER BY n.id
       LIMIT $2`,
    finding: (row) => ({
      id: `missing_evidence:${text(row.node_id)}`,
      check: "missing_evidence",
      severity: "warning",
      subject: { kind: "node", ids: [text(row.node_id)] },
      evidence: { node_type: text(row.node_type), source_type: text(row.source_type) },
      proposal: {
        actionType: "request_confirmation",
        nodeId: num(row.node_id),
        detail: { reason: "no_evidence" },
      },
    }),
  },
  {
    id: "stale_goals",
    title: "Неактуальные цели",
    severity: "warning",
    sql: `/* doctor:stale_goals */
      SELECT g.id AS goal_id, g.status, g.target_date,
             extract(epoch FROM (now() - g.updated_at))::bigint / 86400 AS idle_days
        FROM goals g
       WHERE g.user_id = $1
         AND g.status = 'active'
         AND (
           (g.target_date IS NOT NULL AND g.target_date < current_date)
           OR g.updated_at < now() - interval '120 days'
         )
       ORDER BY g.updated_at
       LIMIT $2`,
    finding: (row) => ({
      id: `stale_goals:${text(row.goal_id)}`,
      check: "stale_goals",
      severity: "warning",
      subject: { kind: "goal", ids: [text(row.goal_id)] },
      evidence: {
        goal_id: num(row.goal_id),
        idle_days: num(row.idle_days),
        target_date: row.target_date ? text(row.target_date).slice(0, 10) : null,
      },
      proposal: {
        actionType: "request_confirmation",
        nodeId: null,
        detail: { goal_id: num(row.goal_id), idle_days: num(row.idle_days) },
      },
    }),
  },
  {
    id: "oversized_core_memory",
    title: "Избыточный объём основной памяти",
    severity: "warning",
    // Бюджет памяти в `CLAUDE.md` — 2500 токенов на все блоки. Здесь
    // считаются знаки проекции: точный счёт токенов принадлежит
    // сборщику контекста, а не диагностике.
    sql: `/* doctor:oversized_core_memory */
      SELECT s.label, length(s.desired_value) AS characters
        FROM letta_memory_block_sync s
       WHERE s.user_id = $1
         AND length(s.desired_value) > ${CORE_MEMORY_CHARACTER_BUDGET}
       ORDER BY length(s.desired_value) DESC
       LIMIT $2`,
    finding: (row) => ({
      id: `oversized_core_memory:${text(row.label)}`,
      check: "oversized_core_memory",
      severity: "warning",
      subject: { kind: "block", ids: [text(row.label)] },
      evidence: { block_label: text(row.label), characters: num(row.characters) },
      proposal: {
        actionType: "resync_block",
        nodeId: null,
        detail: { block_label: text(row.label), characters: num(row.characters) },
      },
    }),
  },
  {
    id: "privacy_mismatch",
    title: "Неверный режим приватности",
    severity: "critical",
    // Догадка модели, лежащая с пометкой `normal`, — это чувствительный
    // вывод, открытый обычным путям чтения.
    sql: `/* doctor:privacy_mismatch */
      SELECT n.id AS node_id, n.node_type, n.sensitivity, n.source_type
        FROM memory_nodes n
       WHERE n.user_id = $1
         AND n.status IN ('active', 'candidate')
         AND n.sensitivity = 'normal'
         AND (
           n.node_type = 'psychological_feature'
           OR (n.content_json->>'sensitive')::boolean IS TRUE
         )
       ORDER BY n.id
       LIMIT $2`,
    finding: (row) => ({
      id: `privacy_mismatch:${text(row.node_id)}`,
      check: "privacy_mismatch",
      severity: "critical",
      subject: { kind: "node", ids: [text(row.node_id)] },
      evidence: {
        node_type: text(row.node_type),
        sensitivity: text(row.sensitivity),
        source_type: text(row.source_type),
      },
      proposal: {
        actionType: "raise_privacy",
        nodeId: num(row.node_id),
        detail: { from: text(row.sensitivity), to: "sensitive" },
      },
    }),
  },
  {
    id: "lost_graph_links",
    title: "Потерянные связи графа",
    severity: "warning",
    sql: `/* doctor:lost_graph_links */
      SELECT e.id AS edge_id, e.from_node_id, e.to_node_id, e.relation_type
        FROM memory_edges e
       WHERE e.user_id = $1
         AND e.status = 'active'
         AND (
           NOT EXISTS (
             SELECT 1 FROM memory_nodes n
              WHERE n.user_id = e.user_id AND n.id = e.from_node_id
                AND n.status IN ('active', 'candidate')
           )
           OR NOT EXISTS (
             SELECT 1 FROM memory_nodes n
              WHERE n.user_id = e.user_id AND n.id = e.to_node_id
                AND n.status IN ('active', 'candidate')
           )
         )
       ORDER BY e.id
       LIMIT $2`,
    finding: (row) => ({
      id: `lost_graph_links:${text(row.edge_id)}`,
      check: "lost_graph_links",
      severity: "warning",
      subject: { kind: "edge", ids: [text(row.edge_id)] },
      evidence: {
        edge_id: num(row.edge_id),
        relation_type: text(row.relation_type),
        from_node_id: num(row.from_node_id),
        to_node_id: num(row.to_node_id),
      },
      proposal: {
        actionType: "archive_edge",
        nodeId: null,
        detail: { edge_id: num(row.edge_id) },
      },
    }),
  },
  {
    id: "orphan_embeddings",
    title: "Осиротевшие embeddings",
    severity: "warning",
    // Таблица появляется шагом 18. До него проверка не «ничего не
    // нашла», а неприменима — и отчёт обязан говорить это прямо.
    dependsOn: "memory_embeddings",
    sql: `/* doctor:orphan_embeddings */
      SELECT m.id AS embedding_id, m.subject_kind, m.subject_id
        FROM memory_embeddings m
       WHERE m.user_id = $1
         AND m.subject_kind = 'node'
         AND NOT EXISTS (
           SELECT 1 FROM memory_nodes n
            WHERE n.user_id = $1 AND n.id = m.subject_id
              AND n.status IN ('active', 'candidate')
         )
       ORDER BY m.id
       LIMIT $2`,
    finding: (row) => ({
      id: `orphan_embeddings:${text(row.embedding_id)}`,
      check: "orphan_embeddings",
      severity: "warning",
      subject: { kind: "embedding", ids: [text(row.embedding_id)] },
      evidence: {
        embedding_id: num(row.embedding_id),
        subject_kind: text(row.subject_kind),
        subject_id: num(row.subject_id),
      },
      proposal: null,
    }),
  },
  {
    id: "letta_divergence",
    title: "Расхождение PostgreSQL и блоков Letta",
    severity: "critical",
    sql: `/* doctor:letta_divergence */
      SELECT s.label, s.status, s.updated_at
        FROM letta_memory_block_sync s
       WHERE s.user_id = $1
         AND s.status IN ('pending', 'failed', 'runtime_override')
         AND s.updated_at < now() - interval '1 hour'
       ORDER BY s.updated_at
       LIMIT $2`,
    finding: (row) => ({
      id: `letta_divergence:${text(row.label)}`,
      check: "letta_divergence",
      severity: text(row.status) === "failed" ? "critical" : "warning",
      subject: { kind: "block", ids: [text(row.label)] },
      evidence: { block_label: text(row.label), sync_status: text(row.status) },
      proposal: {
        actionType: "resync_block",
        nodeId: null,
        detail: { block_label: text(row.label), sync_status: text(row.status) },
      },
    }),
  },
];

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).slice(0, 50);
}
