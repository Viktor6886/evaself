import { badRequest, notFound } from "../errors.js";
import type { ToolManifestRegistry } from "../tools/gateway.js";

export interface ConversationToolSelectorDatabase {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ConversationToolSelectors {
  conversationId: string;
  userId: number;
  currentTaskTools: string[] | null;
  selectedSkillTools: string[] | null;
}

function conversationId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw badRequest("Некорректный идентификатор conversation");
  return id;
}

export class ConversationToolSelectorService {
  constructor(
    private readonly db: ConversationToolSelectorDatabase,
    private readonly registry: ToolManifestRegistry,
  ) {}

  async set(
    conversation: string,
    currentTaskTools: string[] | null,
    selectedSkillTools: string[] | null,
  ): Promise<ConversationToolSelectors> {
    const validate = (tools: string[] | null, field: string): string[] | null => {
      if (tools === null) return null;
      const unique = new Set<string>();
      for (const name of tools) {
        // Deliberately do not trim or normalize control-plane values: only an
        // exact canonical registry key may grant a live SDK capability.
        if (typeof name !== "string" || name.length === 0 || name === "*" || !this.registry.get(name)) {
          throw badRequest(`${field} содержит незарегистрированное canonical имя инструмента`);
        }
        if (unique.has(name)) throw badRequest(`${field} содержит повтор имени инструмента`);
        unique.add(name);
      }
      return [...unique];
    };
    const task = validate(currentTaskTools, "current_task_tools");
    const skill = validate(selectedSkillTools, "selected_skill_tools");
    const id = conversationId(conversation);
    const { rows } = await this.db.query(
      `-- tenant: system — owner/admin control plane; ownership comes only from the selected canonical conversation row
       UPDATE agent_conversations
          SET current_task_tools = $2,
              selected_skill_tools = $3,
              updated_at = now()
        WHERE conversation_id = $1
        RETURNING conversation_id, user_id, current_task_tools, selected_skill_tools`,
      [id, task, skill],
    );
    if (rows.length === 0) throw notFound(`conversation ${id} не найдена`);
    const row = rows[0]!;
    return {
      conversationId: String(row.conversation_id),
      userId: Number(row.user_id),
      currentTaskTools: row.current_task_tools as string[] | null,
      selectedSkillTools: row.selected_skill_tools as string[] | null,
    };
  }
}
