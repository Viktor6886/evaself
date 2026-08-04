import assert from "node:assert/strict";
import test from "node:test";

import { withTenantScopes } from "./tenant-scope-helper.ts";

import {
  ConversationHighlightService,
  extractHighlights,
} from "../dist/memory/conversation-highlights.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("only meaningful messages become conversation highlights", () => {
  const highlights = extractHighlights({
    messages: [
      { id: "m1", content: "Хорошо" },
      {
        id: "m2",
        content: "Мы решили до пятницы собрать работающий прототип и показать его двум людям.",
      },
      {
        id: "m3",
        content: "Полезный источник: https://example.test/research",
      },
    ],
  });

  assert.deepEqual(highlights.map((item) => item.sourceMessageId), ["m2", "m3"]);
  assert.deepEqual(highlights.map((item) => item.type), ["decision", "source"]);
});

test("highlight refresh reads Letta and never writes a full transcript table", async () => {
  const queries: string[] = [];
  const service = new ConversationHighlightService(
    withTenantScopes({
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 1 };
      },
    }) as never,
    {
      listMessages: async () => ({
        messages: [{
          id: "m1",
          content: "Я понял, что короткий таймер помогает начать сложную задачу.",
        }],
      }),
    } as never,
    logger,
    0,
  );

  assert.equal(await service.refresh(41, "conversation-1"), 1);
  assert.ok(queries.every((sql) => sql.includes("conversation_highlights")));
  assert.ok(queries.every((sql) => !/conversation_messages|full_transcript/i.test(sql)));
});
