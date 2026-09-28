/**
 * Документы на сутки: расшифровка и документы, которые Ева прислала.
 *
 * Проверяется то, что обещано человеку: читается только своё и только
 * в пределах суток, просроченное удаляется, повтор вызова не присылает
 * второй файл, а текст отдаётся частями, помещающимися в ход.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DocumentToolFactory,
  docxFilename,
  READ_PAGE_CHARS,
} from "../dist/documents/document-tools.js";
import { stableDocumentId, WorkDocuments } from "../dist/documents/work-documents.js";

const RUNTIME = {
  userId: 7,
  telegramId: 42,
  chatId: 4242,
  conversationId: "conv-1",
  purpose: "chat" as const,
  timezone: "Europe/Moscow",
  responseMode: "text" as const,
  useEmoji: false,
};

interface Row {
  id: string;
  user_id: number;
  kind: string;
  title: string;
  content: string;
  source_name: string | null;
  created_at: string;
  expires_at: string;
  expired: boolean;
}

/** Фейк базы: хранит строки и исполняет ровно те запросы, что шлёт модуль. */
function fakeDb(rows: Row[] = []) {
  const statements: string[] = [];
  let clock = 0;
  const visible = (row: Row) => !row.expired;
  const db = {
    statements,
    rows,
    withUserScope: async <T>(_input: unknown, work: () => Promise<T>) => await work(),
    withSystemScope: async <T>(_reason: string, work: () => Promise<T>) => await work(),
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (sql.includes("INSERT INTO work_documents")) {
        const [id, owner, kind, title, content, source] = values as [string, number, string, string, string, string];
        if (rows.some((row) => row.id === id)) return { rows: [], rowCount: 0 };
        clock += 1;
        const row: Row = {
          id, user_id: owner, kind, title, content, source_name: source ?? null,
          created_at: `2026-09-28T10:00:0${clock}Z`, expires_at: "2026-09-29T10:00:00Z", expired: false,
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (sql.includes("DELETE FROM work_documents")) {
        const before = rows.length;
        for (let index = rows.length - 1; index >= 0; index -= 1) if (rows[index]!.expired) rows.splice(index, 1);
        return { rows: [], rowCount: before - rows.length };
      }
      if (sql.includes("WHERE id = $1 AND user_id = $2")) {
        const found = rows.find((row) => row.id === values[0] && row.user_id === values[1] && visible(row));
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      if (sql.includes("FROM work_documents")) {
        const own = rows
          .filter((row) => row.user_id === values[0] && visible(row) && (values[1] == null || row.kind === values[1]))
          .sort((left, right) => right.created_at.localeCompare(left.created_at));
        return { rows: sql.includes("LIMIT 1\n") || sql.trim().endsWith("LIMIT 1") ? own.slice(0, 1) : own, rowCount: own.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function deliveryProbe() {
  const sent: Array<{ chatId: number; filename: string; bytes: Uint8Array }> = [];
  const rendered: Array<{ title: string; content: string }> = [];
  return {
    sent,
    rendered,
    delivery: {
      async render(title: string, content: string) {
        rendered.push({ title, content });
        return new Uint8Array([80, 75, 3, 4]);
      },
      async send(chatId: number, bytes: Uint8Array, filename: string) {
        sent.push({ chatId, filename, bytes });
      },
    },
  };
}

function tools(db: ReturnType<typeof fakeDb>, delivery: ReturnType<typeof deliveryProbe>["delivery"]) {
  const built = new Map<string, (args: Record<string, unknown>, runtime: typeof RUNTIME, id: string) => Promise<unknown>>();
  new DocumentToolFactory(new WorkDocuments(db as never), delivery).build(((name, _label, _description, _schema, execute) => {
    built.set(name, execute as never);
    return {} as never;
  }) as never);
  return built;
}

test("каждый запрос к документам называет владельца или несёт пометку системного", async () => {
  const db = fakeDb();
  const store = new WorkDocuments(db as never);
  await store.save(7, { kind: "document", title: "Т", content: "x", idempotencyKey: "k" });
  await store.latest(7);
  await store.get(7, "id");
  await store.list(7);
  await store.saveTranscript(42, { title: "Р", content: "y", sourceName: "a.mp3", idempotencyKey: "u" });
  await store.purgeExpired();
  for (const sql of db.statements) {
    assert.ok(/user_id|telegram_id|-- tenant: system/.test(sql), `запрос без владельца: ${sql.slice(0, 80)}`);
  }
});

test("документ живёт сутки: просроченный не читается и удаляется таймером", async () => {
  const db = fakeDb();
  const store = new WorkDocuments(db as never);
  const { document } = await store.save(7, { kind: "transcript", title: "Лекция", content: "текст", idempotencyKey: "a" });
  assert.equal((await store.get(7, document.id))?.content, "текст");
  assert.equal(await store.get(8, document.id), null, "чужой документ прочитался");

  db.rows[0]!.expired = true;
  assert.equal(await store.get(7, document.id), null);
  assert.equal(await store.latest(7), null);
  assert.equal(await store.purgeExpired(), 1);
  assert.equal(db.rows.length, 0);
  assert.ok(db.statements.some((sql) => sql.includes("make_interval(hours => $7)")), "срок не задан при записи");
});

test("стабильный id документа — корректный uuid и не пересекается между людьми", () => {
  const first = stableDocumentId("user:7", "tool:call-1");
  assert.equal(first, stableDocumentId("user:7", "tool:call-1"));
  assert.notEqual(first, stableDocumentId("user:8", "tool:call-1"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("document_read отдаёт текст частями и говорит, где следующая", async () => {
  const db = fakeDb();
  const probe = deliveryProbe();
  const store = new WorkDocuments(db as never);
  const content = "а".repeat(READ_PAGE_CHARS + 500);
  await store.save(7, { kind: "transcript", title: "Встреча", content, idempotencyKey: "t" });
  const read = tools(db, probe.delivery).get("document_read")!;

  const first = await read({}, RUNTIME, "c1") as Record<string, unknown>;
  assert.equal(first.found, true);
  assert.equal(first.total_characters, READ_PAGE_CHARS + 500);
  assert.equal(first.next_offset, READ_PAGE_CHARS);
  const page = first.text as { untrusted: boolean; data: string };
  assert.equal(page.untrusted, true, "расшифровка должна идти материалом, а не инструкцией");
  assert.equal(page.data.length, READ_PAGE_CHARS);

  const second = await read({ offset: READ_PAGE_CHARS }, RUNTIME, "c2") as Record<string, unknown>;
  assert.equal(second.next_offset, null);
  assert.equal((second.text as { data: string }).data.length, 500);

  const other = await read({}, { ...RUNTIME, userId: 8 }, "c3") as Record<string, unknown>;
  assert.equal(other.found, false, "прочитан документ другого человека");
});

test("document_send собирает DOCX, присылает в чат человека и не повторяет файл при повторе вызова", async () => {
  const db = fakeDb();
  const probe = deliveryProbe();
  const send = tools(db, probe.delivery).get("document_send")!;

  const result = await send({ title: "Тезисы: встреча/план?", content: "# Главное\n- Первый" }, RUNTIME, "call-9") as Record<string, unknown>;
  assert.equal(result.sent, true);
  assert.deepEqual(probe.sent.map((item) => [item.chatId, item.filename]), [[4242, "Тезисы_ встреча_план_.docx"]]);
  assert.deepEqual(probe.rendered, [{ title: "Тезисы: встреча/план?", content: "# Главное\n- Первый" }]);
  assert.equal(db.rows[0]!.kind, "document");

  const again = await send({ title: "Тезисы: встреча/план?", content: "# Главное\n- Первый" }, RUNTIME, "call-9") as Record<string, unknown>;
  assert.equal(again.replayed, true);
  assert.equal(probe.sent.length, 1, "повтор того же вызова прислал второй файл");
});

test("имя файла без символов, которых не пропустит файловая система", () => {
  assert.equal(docxFilename('Протокол <встречи>: "итоги"'), "Протокол _встречи__ _итоги_.docx");
  assert.equal(docxFilename("   "), "document.docx");
  assert.equal(docxFilename("я".repeat(300)).length, 155);
});
