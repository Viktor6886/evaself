/**
 * Запрет удаления агента и conversation, пока ход не закончился.
 *
 * Удаление агента в Letta необратимо: вместе с ним уходят conversation,
 * их история и блоки. Если в этот момент выполняется ход, теряется не
 * только он — теряется ответ, который человек ждёт прямо сейчас, и
 * ожидающее подтверждение инструмента, на которое он уже нажал.
 *
 * Проверка идёт по `turn_runs`, а не по пулу сессий в памяти: пул знает
 * только про ходы этого процесса, а канонический факт «ход идёт» живёт в
 * PostgreSQL и переживает перезапуск. Спрашивать память процесса значило
 * бы разрешать удаление всякий раз, когда ход ведёт сосед по кластеру.
 *
 * Запрос кросс-пользовательский намеренно: администратор удаляет чужого
 * агента, и ограничивать выборку его собственным арендатором здесь
 * нельзя — иначе проверка всегда находила бы ноль ходов и всегда
 * разрешала удаление.
 */

import { deletionBlocked } from "../errors.js";
import { TERMINAL_STATES, type TurnState } from "../turns/states.js";

export interface DeleteGuardDatabase {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
  withSystemScope<T>(
    reason: string,
    work: () => Promise<T>,
    options?: { crossUser?: boolean },
  ): Promise<T>;
}

export interface BlockingTurn {
  runId: string;
  state: TurnState;
  conversationId: string | null;
}

export class DeleteGuard {
  private readonly db: DeleteGuardDatabase;

  constructor(db: DeleteGuardDatabase) {
    this.db = db;
  }

  /** Незавершённые ходы агента. Пустой список — удалять можно. */
  async blockingTurnsForAgent(agentId: string): Promise<BlockingTurn[]> {
    return await this.find("agent_id", agentId, "letta.delete-guard.agent");
  }

  /** Незавершённые ходы одной conversation. */
  async blockingTurnsForConversation(conversationId: string): Promise<BlockingTurn[]> {
    return await this.find("conversation_id", conversationId, "letta.delete-guard.conversation");
  }

  /**
   * Остановить удаление агента, если он занят.
   *
   * Отдельно называется ожидающее подтверждение: администратор, увидев
   * «ход выполняется», подождёт минуту, а `approval_pending` может висеть
   * часами и требует не ожидания, а решения.
   */
  async assertAgentDeletable(agentId: string): Promise<void> {
    this.assertEmpty(await this.blockingTurnsForAgent(agentId), "агента", agentId);
  }

  async assertConversationDeletable(conversationId: string): Promise<void> {
    this.assertEmpty(
      await this.blockingTurnsForConversation(conversationId),
      "conversation",
      conversationId,
    );
  }

  private assertEmpty(turns: BlockingTurn[], kind: string, id: string): void {
    if (turns.length === 0) return;
    const awaitingApproval = turns.filter((turn) => turn.state === "approval_pending");
    const detail = awaitingApproval.length > 0
      ? `ожидают подтверждения: ${awaitingApproval.length}`
      : `выполняются ходы: ${turns.length}`;
    throw deletionBlocked(
      `Удаление ${kind} ${id} запрещено, пока ход не закончился (${detail})`,
      {
        target: id,
        blocking_turns: turns.length,
        awaiting_approval: awaitingApproval.length,
        // Идентификаторы ходов и состояния — служебные значения, не
        // содержимое переписки: их можно показать администратору.
        states: [...new Set(turns.map((turn) => turn.state))],
      },
    );
  }

  private async find(
    column: "agent_id" | "conversation_id",
    value: string,
    reason: string,
  ): Promise<BlockingTurn[]> {
    // Колонка — не входные данные: она выбирается из двух литералов выше,
    // и подставить сюда произвольное имя вызывающий не может.
    const { rows } = await this.db.withSystemScope(
      reason,
      async () => await this.db.query(
        `-- tenant: system — административное удаление затрагивает чужого агента, и выборка обязана видеть ходы всех пользователей
         SELECT run_id, state, conversation_id
           FROM turn_runs
          WHERE ${column} = $1
            AND state <> ALL ($2::text[])
          ORDER BY created_at
          LIMIT 50`,
        [value, [...TERMINAL_STATES]],
      ),
      { crossUser: true },
    );
    return rows.map((row) => ({
      runId: String(row.run_id ?? ""),
      state: String(row.state ?? "") as TurnState,
      conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    }));
  }
}
