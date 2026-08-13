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
            AND status IN ('active', 'inactive')
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
    let canonicalLink: LinkRow | undefined;
    const result = await this.transaction(telegramId, async (client, link) => {
      canonicalLink = link;
      const record = await this.letta.createConversationRecord(link.agent_id, { summary: normalizedTitle }) as { id?: string };
      createdId = this.validId(record.id ?? "", "Letta вернула некорректный ID диалога");
      await client.query(
        `INSERT INTO agent_conversations (user_id, agent_id, conversation_id, purpose, title, status)
         VALUES ($1, $2, $3, 'chat', $4, 'inactive')`,
        [link.user_id, link.agent_id, createdId, normalizedTitle],
      );
      return { id: createdId, title: normalizedTitle, active: false };
    }, true, async (error) => {
      if (createdId) await this.compensateArchive(createdId, error);
      throw error;
    }, async (error): Promise<true> => {
      if (await this.reconcileStatus(canonicalLink!, createdId, error) === "inactive") return true;
      return await this.compensateArchive(createdId, error);
    });
    await this.audit({ action: "conversation.create", telegramId, conversationId: createdId });
    return result;
  }

  async activate(telegramId: number, conversationId: string): Promise<Record<string, unknown>> {
    const id = this.validId(conversationId);
    let canonicalLink: LinkRow | undefined;
    const result = await this.transaction(telegramId, async (client, link) => {
      canonicalLink = link;
      const row = await this.ownedSelectable(client, link, id);
      if (link.active_conversation_id === id) throw badRequest("Диалог уже активен");
      await client.query(
        `UPDATE agent_conversations SET status = 'inactive'
          WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
            AND purpose = 'chat' AND status = 'active'`,
        [link.user_id, link.agent_id, link.active_conversation_id],
      );
      await client.query(
        `UPDATE agent_conversations SET status = 'active'
          WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
            AND purpose = 'chat' AND status = 'inactive'`,
        [link.user_id, link.agent_id, id],
      );
      await client.query(
        `UPDATE agent_links SET conversation_id = $3, message_count = 0
          WHERE user_id = $1 AND agent_id = $2`,
        [link.user_id, link.agent_id, id],
      );
      return { ...row, id, active: true };
    }, true, undefined, async (error) => {
      if (await this.reconcileActivation(canonicalLink!, id, error)) return true;
      throw error;
    });
    await this.audit({ action: "conversation.activate", telegramId, conversationId: id });
    return result;
  }

  async archive(telegramId: number, conversationId: string): Promise<Record<string, unknown>> {
    const id = this.validId(conversationId);
    let archivedInLetta = false;
    let canonicalLink: LinkRow | undefined;
    const result = await this.transaction(telegramId, async (client, link) => {
      canonicalLink = link;
      await this.ownedSelectable(client, link, id);
      if (link.active_conversation_id === id) {
        throw deletionBlocked("Сначала переключитесь на другой диалог, затем архивируйте этот", { target: id });
      }
      await this.deleteGuard.assertConversationDeletable(id);
      await this.letta.updateConversation(id, { archived: true });
      archivedInLetta = true;
      await client.query(
        `UPDATE agent_conversations
            SET status = 'archived', archived_at = now(), meta = meta || '{"webapp_archived":true}'::jsonb
          WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3 AND status = 'inactive'`,
        [link.user_id, link.agent_id, id],
      );
      return { id, archived: true };
    }, true, async (error) => {
      if (archivedInLetta) {
        try {
          await this.letta.updateConversation(id, { archived: false });
        } catch (compensationError) {
          throw new AggregateError([error, compensationError], "Не удалось сохранить архивирование и восстановить диалог в Letta");
        }
      }
      throw error;
    }, async (error) => {
      if (await this.reconcileStatus(canonicalLink!, id, error) === "archived") return true;
      if (archivedInLetta) {
        try { await this.letta.updateConversation(id, { archived: false }); }
        catch (compensationError) { throw new AggregateError([error, compensationError], "Не удалось подтвердить архивирование и восстановить диалог в Letta"); }
      }
      throw error;
    });
    await this.audit({ action: "conversation.archive", telegramId, conversationId: id });
    return result;
  }

  private async ownedSelectable(client: TransactionClient, link: LinkRow, id: string): Promise<ConversationRow> {
    const { rows } = await client.query<ConversationRow>(
      `SELECT conversation_id AS id, title, status, created_at, updated_at
         FROM agent_conversations
        WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3
          AND purpose = 'chat' AND status IN ('active', 'inactive')
        FOR UPDATE`,
      [link.user_id, link.agent_id, id],
    );
    if (!rows[0]) throw notFound("Диалог не найден");
    return rows[0];
  }

  private async transaction<T>(telegramId: number, work: (client: TransactionClient, link: LinkRow) => Promise<T>, lock = true, onFailure?: (error: unknown) => Promise<never>, onCommitUnknown?: (error: unknown) => Promise<true | never>): Promise<T> {
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw badRequest("Некорректный Telegram ID");
    const client = await this.db.transactionClient();
    let committed = false;
    let committing = false;
    let result!: T;
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
      result = await work(client, rows[0]);
      committing = true;
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      if (committing && onCommitUnknown && await onCommitUnknown(error)) return result;
      let transactionError = error;
      if (!committed && !committing) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          transactionError = new AggregateError([error, rollbackError], "Транзакция и откат завершились ошибкой");
        }
      }
      if (!committed && !committing && onFailure) await onFailure(transactionError);
      throw transactionError;
    } finally {
      client.release();
    }
  }

  private async reconcileStatus(link: LinkRow, id: string, commitError: unknown): Promise<string | undefined> {
    let client: TransactionClient | undefined;
    try {
      client = await this.db.transactionClient();
      await client.query("BEGIN");
      const { rows } = await client.query<{ status: string }>(
        `-- canonical conversation status after ambiguous COMMIT
         SELECT status FROM agent_conversations
          WHERE user_id = $1 AND agent_id = $2 AND conversation_id = $3 AND purpose = 'chat'`,
        [link.user_id, link.agent_id, id],
      );
      await client.query("COMMIT");
      return rows[0]?.status;
    } catch (verificationError) {
      throw new AggregateError([commitError, verificationError], "COMMIT outcome unknown; recovery required");
    } finally { client?.release(); }
  }

  private async reconcileActivation(link: LinkRow, id: string, commitError: unknown): Promise<boolean> {
    let client: TransactionClient | undefined;
    try {
      client = await this.db.transactionClient();
      await client.query("BEGIN");
      const { rows } = await client.query<{ active_conversation_id: string | null; active_status: string | null; target_status: string | null }>(
        `-- canonical active conversation after ambiguous COMMIT
         SELECT l.conversation_id AS active_conversation_id, active.status AS active_status, target.status AS target_status
           FROM agent_links l
           LEFT JOIN agent_conversations active ON active.user_id = l.user_id AND active.agent_id = l.agent_id AND active.conversation_id = l.conversation_id AND active.purpose = 'chat'
           LEFT JOIN agent_conversations target ON target.user_id = l.user_id AND target.agent_id = l.agent_id AND target.conversation_id = $3 AND target.purpose = 'chat'
          WHERE l.user_id = $1 AND l.agent_id = $2 AND l.kind = 'eva' AND l.status = 'active'`,
        [link.user_id, link.agent_id, id],
      );
      await client.query("COMMIT");
      if (rows.length !== 1) throw new Error("Canonical agent link is missing or ambiguous");
      const activeId = rows[0]!.active_conversation_id;
      if (activeId === id && rows[0]!.active_status === "active" && rows[0]!.target_status === "active") return true;
      if (activeId === link.active_conversation_id && rows[0]!.active_status === "active" && rows[0]!.target_status === "inactive") return false;
      throw new Error("Canonical agent link has an unexpected active conversation");
    } catch (verificationError) {
      throw new AggregateError([commitError, verificationError], "COMMIT outcome unknown; recovery required");
    } finally { client?.release(); }
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
