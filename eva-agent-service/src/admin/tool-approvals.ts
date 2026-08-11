/**
 * Инструменты и approvals — честный read-only обзор того, что есть сегодня.
 *
 * Почему read-only. Реестр манифестов инструментов, уровни риска, версии,
 * kill switch и durable approvals — это Tool Gateway, шаг 14. Его в
 * репозитории нет. Сделать здесь «управление инструментами» значило бы
 * завести второй реестр, который через шаг придётся сносить, и показать
 * администратору кнопки, за которыми ничего не стоит. Шаг 12 это прямо
 * запрещает: для подсистем, которых ещё нет, раздел честный и read-only.
 *
 * Что при этом показывается — не заглушка, а факты:
 *
 *   политика по назначению conversation — из `purposePolicy()`, того самого
 *     кода, который решает видимость инструмента в ходе;
 *   фактические вызовы — из `tool_effects`, журнала побочных эффектов:
 *     какие инструменты действительно исполнялись, сколько раз и сколько
 *     из них отказало;
 *   ожидающие approvals — из `turn_runs` в состоянии `approval_pending`:
 *     сегодня это единственный канонический признак «ход ждёт решения».
 *
 * Ни имён аргументов, ни результатов вызовов, ни содержания разговора в
 * ответах нет: `tool_effects.result` не читается ни одним запросом.
 */

import {
  CONVERSATION_PURPOSES,
  purposePolicy,
} from "../conversations/purpose-service.js";

export interface ToolInventoryDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Статусы подсистем, которых ещё нет, объявляются одинаково. */
export interface SubsystemStatus {
  implemented: boolean;
  planned_step: string;
  detail: string;
}

const TOOL_REGISTRY_STATUS: SubsystemStatus = {
  implemented: false,
  planned_step: "14 — Tool Gateway, durable approvals и политика MCP",
  detail: "Манифесты инструментов, уровни риска, версии и kill switch появляются вместе "
    + "со шлюзом. Сегодня видимость инструмента решает политика назначения conversation.",
};

const APPROVALS_STATUS: SubsystemStatus = {
  implemented: false,
  planned_step: "14 — Tool Gateway, durable approvals и политика MCP",
  detail: "Хранилища approvals ещё нет: постоянные правила, сроки действия и отзыв "
    + "появляются вместе со шлюзом. Сегодня видно только ходы, остановленные в "
    + "состоянии approval_pending.",
};

export class ToolApprovalService {
  constructor(private readonly db: ToolInventoryDatabase) {}

  /**
   * Политики по назначению conversation и фактические вызовы.
   *
   * `allowed_tools: null` означает «ограничения по назначению нет», а не
   * «инструментов нет»: финальной границей видимости остаётся allowedTools
   * конкретного хода.
   */
  async tools(days = 7): Promise<Record<string, unknown>> {
    const window = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
    const policies = CONVERSATION_PURPOSES.map((purpose) => {
      const policy = purposePolicy(purpose);
      return {
        purpose,
        can_send_to_user: policy.canSendToUser,
        can_change_profile: policy.canChangeProfile,
        allowed_tools: policy.allowedTools,
      };
    });

    const { rows } = await this.db.query(
      `-- tenant: system — сводка вызовов инструментов по установке целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT tool_name,
              count(*) AS calls,
              count(*) FILTER (WHERE status = 'failed') AS failed,
              count(*) FILTER (WHERE status = 'running') AS running,
              max(created_at) AS last_call_at
         FROM tool_effects
        WHERE created_at > now() - make_interval(days => $1::int)
        GROUP BY tool_name
        ORDER BY calls DESC, tool_name
        LIMIT 200`,
      [window],
    );

    return {
      status: TOOL_REGISTRY_STATUS,
      window_days: window,
      purposes: policies,
      observed_tools: rows,
    };
  }

  /**
   * Ожидающие и недавно решённые подтверждения.
   *
   * «Решённые» выводятся из журнала переходов: ход, побывавший в
   * `approval_pending` и ушедший дальше, — это и есть решённый запрос.
   * Инициатор называется каналом и владельцем хода, а не текстом запроса:
   * содержания разговора здесь нет.
   */
  async approvals(limit = 50): Promise<Record<string, unknown>> {
    const bounded = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const { rows: pending } = await this.db.query(
      `-- tenant: system — ходы установки, остановленные подтверждением; область администратора объявлена маршрутом и записана в аудит
       SELECT run_id, user_id, channel, agent_id, conversation_id, purpose,
              attempt, created_at, updated_at,
              EXTRACT(EPOCH FROM (now() - updated_at))::bigint AS waiting_seconds
         FROM turn_runs
        WHERE state = 'approval_pending'
        ORDER BY updated_at
        LIMIT $1`,
      [bounded],
    );

    const { rows: resolved } = await this.db.query(
      `-- tenant: system — недавно решённые подтверждения по установке целиком; область администратора объявлена маршрутом и записана в аудит
       SELECT t.run_id, t.to_state AS resolution, t.at, t.error_code
         FROM turn_transitions t
        WHERE t.from_state = 'approval_pending'
        ORDER BY t.at DESC
        LIMIT $1`,
      [bounded],
    );

    return {
      status: APPROVALS_STATUS,
      pending,
      resolved,
      standing_rules: [],
    };
  }
}
