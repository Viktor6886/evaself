/**
 * Документ базы знаний в области владельца (docs/knowledge-base.md, K3b).
 *
 * Владелец — человек (личная база) или никто (общая база администратора,
 * документ лежит в коллекции). Условие области пишется здесь один раз и
 * используется и агентом (приём, индексация), и панелью (общая база):
 * забытое `AND user_id = $2` в одном из мест — утечка, которую зелёные
 * тесты не покажут.
 *
 * Удаление документа — одна транзакция в PostgreSQL: документ, его
 * фрагменты (каскад) и записи приёма. Точки Qdrant и исходный файл
 * снимает задание `knowledge_index`, записанное в той же транзакции:
 * для документа, которого больше нет, оно означает «убрать его следы».
 * Qdrant недоступен — задание повторится; PostgreSQL уже не отдаёт
 * документ ни поиску, ни человеку.
 */

import { join } from "node:path";

import type { JobOutboxClient } from "../jobs/job-outbox.js";

export type KnowledgeOwner = { kind: "user"; userId: number } | { kind: "global" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isKnowledgeId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Владелец по `userId` конверта задания: null — общая база. */
export function knowledgeOwner(userId: number | null): KnowledgeOwner {
  if (userId === null) return { kind: "global" };
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("knowledge_user_invalid");
  return { kind: "user", userId };
}

/**
 * Исходный файл загрузки: `<root>/<id человека | global>/<id загрузки>`.
 * Id проверяется как uuid: путь собирается из него, и `..` в нём вывел
 * бы запись за пределы тома.
 */
export function knowledgeUploadPath(root: string, owner: KnowledgeOwner, uploadId: string): string {
  if (!isKnowledgeId(uploadId)) throw new Error("knowledge_upload_invalid");
  return join(root, owner.kind === "user" ? String(owner.userId) : "global", uploadId);
}

/** Постановка задания синхронизации документа с Qdrant — см. `indexer.ts`. */
export interface KnowledgeDocumentJobs {
  schedule(client: JobOutboxClient, input: { documentId: string; userId: number | null; reason: string }): Promise<void>;
}

/**
 * Удалить документы владельца. Чужой id молча пропускается: удалено ровно
 * то, что вернул `DELETE … RETURNING`, и задания ставятся только на это.
 */
export async function deleteKnowledgeDocuments(
  client: JobOutboxClient,
  owner: KnowledgeOwner,
  documentIds: readonly string[],
  jobs: KnowledgeDocumentJobs,
): Promise<string[]> {
  const ids = [...new Set(documentIds.filter(isKnowledgeId))];
  if (!ids.length) return [];
  const deleted = owner.kind === "user"
    ? await client.query<{ id: string }>(
      `DELETE FROM knowledge_documents
        WHERE id = ANY($1::uuid[]) AND user_id = $2
        RETURNING id`,
      [ids, owner.userId],
    )
    : await client.query<{ id: string }>(
      `DELETE FROM knowledge_documents
        -- tenant: system — документы общей базы: владельца нет, доступ по коллекции
        WHERE id = ANY($1::uuid[]) AND user_id IS NULL AND product_verified
        RETURNING id`,
      [ids],
    );
  const removed = deleted.rows.map((row) => String(row.id));
  if (!removed.length) return [];
  // Записи приёма уходят вместе с документом: исходный файл больше
  // ничему не принадлежит, и задание его удалит.
  if (owner.kind === "user") {
    await client.query(
      "DELETE FROM knowledge_uploads WHERE document_id = ANY($1::uuid[]) AND user_id = $2",
      [removed, owner.userId],
    );
  } else {
    await client.query(
      `DELETE FROM knowledge_uploads
        -- tenant: system — записи приёма общей базы
        WHERE document_id = ANY($1::uuid[]) AND user_id IS NULL`,
      [removed],
    );
  }
  for (const documentId of removed) {
    await jobs.schedule(client, {
      documentId,
      userId: owner.kind === "user" ? owner.userId : null,
      reason: "delete",
    });
  }
  return removed;
}
