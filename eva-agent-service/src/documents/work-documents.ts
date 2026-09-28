import { createHash } from "node:crypto";

import type { Database } from "../db.js";

/**
 * Рабочие документы на сутки: полная расшифровка записи и документы,
 * которые Ева составила по просьбе человека.
 *
 * Расшифровка двухчасовой записи в ход Евы целиком не помещается, а
 * просьба «сделай тезисами» приходит следующим сообщением. Текст лежит
 * сутки: Ева читает его частями и присылает новый файл. Через сутки он
 * удаляется — чтение просроченное уже не видит, а таймер агента удаляет
 * строки физически (`purgeExpired`). Байты самих DOCX здесь не хранятся:
 * очередь отправки вычищает их, как только строка доставлена или
 * окончательно не доставлена.
 */

export const WORK_DOCUMENT_TTL_HOURS = 24;

export type WorkDocumentKind = "transcript" | "document";

export interface WorkDocument {
  id: string;
  kind: WorkDocumentKind;
  title: string;
  content: string;
  sourceName: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Узкий контракт базы: тот же, что у остальных сервисов с областью арендатора. */
type WorkDocumentsDatabase = Pick<Database, "query" | "withUserScope" | "withSystemScope">;

/** UUID из ключа идемпотентности: повтор того же хода или вызова не заводит копию. */
export function stableDocumentId(owner: string, key: string): string {
  const hex = createHash("sha256").update(`work-document:${owner}:${key}`).digest("hex");
  // Версия 5 и вариант RFC 4122: строка остаётся корректным uuid для колонки.
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

const COLUMNS = `id::text AS id, kind, title, content, source_name,
  created_at::text AS created_at, expires_at::text AS expires_at`;

function asDocument(row: Record<string, unknown>): WorkDocument {
  return {
    id: String(row.id),
    kind: row.kind === "document" ? "document" : "transcript",
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    sourceName: row.source_name == null ? null : String(row.source_name),
    createdAt: String(row.created_at ?? ""),
    expiresAt: String(row.expires_at ?? ""),
  };
}

export class WorkDocuments {
  constructor(private readonly db: WorkDocumentsDatabase) {}

  /**
   * Сохранить документ по внутреннему id пользователя (инструменты Евы).
   * Повтор с тем же ключом возвращает уже сохранённый документ.
   */
  async save(userId: number, input: {
    kind: WorkDocumentKind;
    title: string;
    content: string;
    sourceName?: string | null;
    idempotencyKey: string;
  }): Promise<{ document: WorkDocument; created: boolean }> {
    const id = stableDocumentId(`user:${userId}`, input.idempotencyKey);
    return await this.db.withUserScope({ userId, label: "work_documents.save", inherit: true }, async () => {
      const inserted = await this.db.query<Record<string, unknown>>(
        `INSERT INTO work_documents (id, user_id, kind, title, content, source_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7))
         ON CONFLICT (id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [id, userId, input.kind, input.title.slice(0, 300), input.content, input.sourceName ?? null,
          WORK_DOCUMENT_TTL_HOURS],
      );
      if (inserted.rows[0]) return { document: asDocument(inserted.rows[0]), created: true };
      const existing = await this.get(userId, id);
      if (!existing) throw new Error("Документ с этим ключом уже удалён по сроку");
      return { document: existing, created: false };
    });
  }

  /**
   * Сохранить расшифровку по Telegram id — так её знает ход, где
   * внутреннего id под рукой нет. Ключ — номер апдейта.
   */
  async saveTranscript(telegramId: number, input: {
    title: string;
    content: string;
    sourceName: string | null;
    idempotencyKey: string;
  }): Promise<string | null> {
    const id = stableDocumentId(`telegram:${telegramId}`, input.idempotencyKey);
    const { rows } = await this.db.withUserScope(
      { telegramId, label: "work_documents.transcript", inherit: true },
      async () => await this.db.query<{ id: string }>(
        `INSERT INTO work_documents (id, user_id, kind, title, content, source_name, expires_at)
         SELECT $1, u.id, 'transcript', $3, $4, $5, now() + make_interval(hours => $6)
           FROM users u
          WHERE u.telegram_id = $2
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING id::text AS id`,
        [id, telegramId, input.title.slice(0, 300), input.content, input.sourceName, WORK_DOCUMENT_TTL_HOURS],
      ),
    );
    return rows[0]?.id ?? null;
  }

  /** Документ по id — только свой и только в пределах суток. */
  async get(userId: number, id: string): Promise<WorkDocument | null> {
    const { rows } = await this.db.withUserScope({ userId, label: "work_documents.get", inherit: true }, async () =>
      await this.db.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM work_documents
          WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
        [id, userId],
      ));
    return rows[0] ? asDocument(rows[0]) : null;
  }

  /** Последний документ человека: «переделай то, что ты прислала». */
  async latest(userId: number, kind?: WorkDocumentKind): Promise<WorkDocument | null> {
    const { rows } = await this.db.withUserScope({ userId, label: "work_documents.latest", inherit: true }, async () =>
      await this.db.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM work_documents
          WHERE user_id = $1 AND expires_at > now() AND ($2::text IS NULL OR kind = $2)
          ORDER BY created_at DESC
          LIMIT 1`,
        [userId, kind ?? null],
      ));
    return rows[0] ? asDocument(rows[0]) : null;
  }

  /** Короткий список живых документов: какие есть и до какого времени. */
  async list(userId: number): Promise<Array<Omit<WorkDocument, "content"> & { characters: number }>> {
    const { rows } = await this.db.withUserScope({ userId, label: "work_documents.list", inherit: true }, async () =>
      await this.db.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM work_documents
          WHERE user_id = $1 AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 10`,
        [userId],
      ));
    return rows.map((row) => {
      const { content, ...rest } = asDocument(row);
      return { ...rest, characters: content.length };
    });
  }

  /**
   * Удалить просроченное — у всех пользователей сразу.
   *
   * Пакетами: строк немного, но один запрос без предела держал бы
   * блокировку дольше, чем нужно. Байты самих DOCX сюда не относятся: их
   * вычищает очередь отправки, как только строка стала окончательной.
   */
  async purgeExpired(batch = 500): Promise<number> {
    return await this.db.withSystemScope("work_documents.purge", async () => {
      const deleted = await this.db.query(
        `-- tenant: system — удаление по сроку хранения у всех пользователей, не запрос одного из них
         DELETE FROM work_documents
          WHERE id IN (
            SELECT id FROM work_documents
             WHERE expires_at <= now()
             ORDER BY expires_at
             LIMIT $1
          )`,
        [batch],
      );
      return deleted.rowCount ?? 0;
    }, { crossUser: true });
  }
}
