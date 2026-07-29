import type { Database } from "../db.js";
import type { LettaService } from "../letta.js";
import type { Logger } from "../logger.js";

interface Highlight {
  sourceMessageId: string | null;
  type: "decision" | "commitment" | "artifact" | "source" | "insight";
  title: string;
  content: string;
  sourceQuote: string;
  importance: number;
}

/**
 * A bounded asynchronous index of meaningful history. Letta remains the source
 * of truth; PostgreSQL receives no complete transcript and no extra LLM call.
 */
export class ConversationHighlightService {
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly logger: Logger,
    private readonly intervalMs = 5 * 60_000,
  ) {}

  schedule(userId: number, conversationId: string): void {
    if (
      this.running.has(conversationId) ||
      (this.nextAllowedAt.get(conversationId) ?? 0) > Date.now()
    ) {
      return;
    }
    this.running.add(conversationId);
    this.nextAllowedAt.set(conversationId, Date.now() + this.intervalMs);
    setImmediate(() => {
      void this.refresh(userId, conversationId)
        .catch((error) => {
          this.logger.warn("Не удалось обновить важные фрагменты conversation", {
            userId,
            conversationId,
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => this.running.delete(conversationId));
    });
  }

  async refresh(userId: number, conversationId: string): Promise<number> {
    const history = await this.letta.listMessages(conversationId, 40);
    const highlights = extractHighlights(history).slice(0, 10);
    let stored = 0;
    for (const highlight of highlights) {
      const result = await this.db.query(
        `INSERT INTO conversation_highlights (
           user_id, conversation_id, source_message_id, highlight_type,
           title, content, source_quote, importance
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (conversation_id, source_message_id, highlight_type)
           WHERE source_message_id IS NOT NULL
         DO NOTHING`,
        [
          userId,
          conversationId,
          highlight.sourceMessageId,
          highlight.type,
          highlight.title,
          highlight.content,
          highlight.sourceQuote,
          highlight.importance,
        ],
      );
      stored += result.rowCount ?? 0;
    }
    return stored;
  }
}

export function extractHighlights(value: unknown): Highlight[] {
  const messages = messageList(value);
  const result: Highlight[] = [];
  for (const message of messages) {
    const text = messageText(message).replace(/\s+/g, " ").trim().slice(0, 8_000);
    if (text.length < 24) continue;
    const classified = classify(text);
    if (!classified) continue;
    const record = asRecord(message);
    result.push({
      sourceMessageId: stringValue(
        record.id ?? record.message_id ?? record.messageId,
      ),
      type: classified.type,
      title: firstSentence(text).slice(0, 300),
      content: text,
      sourceQuote: text.slice(0, 500),
      importance: classified.importance,
    });
  }
  return result;
}

function messageList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  for (const key of ["messages", "items", "data", "results"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function classify(text: string): Pick<Highlight, "type" | "importance"> | null {
  if (/https?:\/\/\S+/iu.test(text)) return { type: "source", importance: 0.65 };
  if (/(?:мы решили|я решил[а]?|решение|договорились|выбираю|decision)/iu.test(text)) {
    return { type: "decision", importance: 0.9 };
  }
  if (/(?:я сделаю|обязуюсь|до \d|дедлайн|следующий шаг|commitment)/iu.test(text)) {
    return { type: "commitment", importance: 0.85 };
  }
  if (/(?:готово|создан|собран|артефакт|результат:|artifact)/iu.test(text)) {
    return { type: "artifact", importance: 0.8 };
  }
  if (/(?:я понял[а]?|важно, что|наблюдение|выяснилось|insight)/iu.test(text)) {
    return { type: "insight", importance: 0.7 };
  }
  return null;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join("\n");
  const record = asRecord(value);
  for (const key of ["text", "content", "message", "value"]) {
    const text = messageText(record[key]);
    if (text) return text;
  }
  return "";
}

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s/u, 1)[0] || text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, 300)
    : null;
}
