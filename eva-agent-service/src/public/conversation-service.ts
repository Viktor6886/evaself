import type { Database } from "../db.js";
import { badRequest, deletionBlocked, notFound } from "../errors.js";
import type { LettaService } from "../letta.js";
import type { DeleteGuard } from "../letta/delete-guard.js";

export interface ConversationAuditEvent {
  action: "conversation.create" | "conversation.activate" | "conversation.archive";
  telegramId: number;
  conversationId: string;
}

type AuditConversation = (event: ConversationAuditEvent) => Promise<void>;
type TransactionClient = Awaited<ReturnType<Database["transactionClient"]>>;

interface LinkRow {
  user_id: string;
  agent_id: string;
  active_conversation_id: string | null;
}
interface ConversationRow extends Record<string, unknown> {
  id: string;
  title: string | null;
  status: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ConversationService {
  constructor(
    private readonly db: Pick<Database, "transactionClient">,
    private readonly letta: Pick<LettaService, "createConversationRecord" | "updateConversation">,
    private readonly deleteGuard: Pick<DeleteGuard, "assertConversationDeletable">,
    private readonly audit: AuditConversation,
  ) {}

  async list(telegramId: number): Promise<Record<string, unknown>[]> {
    return await this.transaction(telegramId, async (client, link) => {
      const { rows } = await client.query(
        `SELECT conversation_id AS id,
                COALESCE(NULLIF(title, ''), 'Диалог с Евой') AS title,
                conversation_id = $3 AS active, created_at, updated_at
           FROM agent_conversations
          WHERE user_id = $1 AND agent_id = $2 AND purpose = 'chat'
            AND status = 'active'
          ORDER BY (conversation_id = $3) DESC, updated_at DESC`,
        [link.user_id, link.agent_id, link.active_conversation_id],
      );
      return rows;
    }, false);
  }

  async create(telegramId: number, title: string): Promise<Record<string, unknown>> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle || normalizedTitle.length > 120) throw badRequest("Название диалога должно содержать от 1 до 120 символов");
    let createdId = "";
    const result = await this.transaction(telegramId, async (client, link) => {
      const record = await this.letta.createConversationRecord(link.agent_id, { summary: normalizedTitle }) as { id?: string };
      createdId = this.validId(record.id ?? "", "Letta вернула некорректный ID диалога");
      try {
        await client.query(
          `INSERT INTO agent_conversations (user_id, agent_id, conversation_id, purpose, title, status)
           VALUES ($1, $2, $3, 'chat', $4, 'active')`,
          [link.user_id, link.agent_id, createdId, normalizedTitle],
        );
      } catch (error) {
        await this.compensateArchive(createdId, error);
      }
      return { id: createdId, title: normalizedTitle, active: false };
    });
    await this.audit({ action: "conversation.create", telegramId, conversationId: createdId });
    return result;
  }

  async activate(telegramId: number, conversationId: string): Promise<Record<string, unknown>> {
    const id = this.validId(conversationId);
    const result = await this.transaction(telegramId, async (client, link) => {
      const row = await this.ownedSelectable(client, link, id);
      if (link.active_conversation_id === id) throw badRequest("Диалог уже активен");
      await client.query(
        `UPDATE agent_links SET conversation_id = $3, message_count = 0
          WHERE user_id = $1 AND agent_id = $2`,
        [link.user_id, link.agent_id, id],
      );
      return { ...row, id, active: true };
    });
    await this.audit({ action: "conversation.activate", telegramId, conversationId: id });
    return result;
  }

  async archive(telegramId: number, conversationId: string): Promise<Record<string, unknown>> {
    const id = this.validId(conversationId);
    const result = await this.transaction(telegramId, async (client, link) => {
      await this.ownedSelectable(client, link, id);
      if (link.active_conversation_id === id) {
        throw deletionBlocked("Сначала переключитесь на другой диалог, затем архивируйте этот", { target: id });
      }
      await this.deleteGuard.assertConversationDeletable(id);
      await this.letta.updateConversation(id, { archived: true });
      try {
        await client.query(
          `UPDATE agent_conversations
              SET status = 'archived', archived_at = now(), meta = meta || '{"webapp_archived":true}'::jsonb
            WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3 AND status = 'active'`,
          [link.user_id, link.agent_id, id],
        );
      } catch (error) {
        try {
          await this.letta.updateConversation(id, { archived: false });
        } catch (compensationError) {
          throw new AggregateError([error, compensationError], "Не удалось сохранить архивирование и восстановить диалог в Letta");
        }
        throw error;
      }
      return { id, archived: true };
    });
    await this.audit({ action: "conversation.archive", telegramId, conversationId: id });
    return result;
  }

  private async ownedSelectable(client: TransactionClient, link: LinkRow, id: string): Promise<ConversationRow> {
    const { rows } = await client.query<ConversationRow>(
      `SELECT conversation_id AS id, title, status, created_at, updated_at
         FROM agent_conversations
        WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
          AND purpose = 'chat' AND status = 'active'
        FOR UPDATE`,
      [link.user_id, link.agent_id, id],
    );
    if (!rows[0]) throw notFound("Диалог не найден");
    return rows[0];
  }

  private async transaction<T>(telegramId: number, work: (client: TransactionClient, link: LinkRow) => Promise<T>, lock = true): Promise<T> {
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw badRequest("Некорректный Telegram ID");
    const client = await this.db.transactionClient();
    try {
      await client.query("BEGIN");
      if (lock) await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [telegramId]);
      const { rows } = await client.query<LinkRow>(
        `-- tenant: by verified telegram_id and owned user_id/agent_id link
         SELECT a.user_id, a.agent_id, a.conversation_id AS active_conversation_id
           FROM users u JOIN agent_links a ON a.user_id = u.id
          WHERE u.telegram_id = $1 AND a.kind = 'eva' AND a.status = 'active'
          ORDER BY a.created_at DESC LIMIT 1
          FOR UPDATE OF a`,
        [telegramId],
      );
      if (!rows[0]) throw notFound("Агент Евы ещё не создан");
      const result = await work(client, rows[0]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private validId(value: string, message = "Некорректный ID диалога"): string {
    if (!ID_PATTERN.test(value)) throw badRequest(message);
    return value;
  }

  private async compensateArchive(id: string, original: unknown): Promise<never> {
    try {
      await this.letta.updateConversation(id, { archived: true });
    } catch (compensationError) {
      throw new AggregateError([original, compensationError], "Не удалось зарегистрировать или архивировать новый диалог");
    }
    throw original;
  }
}
