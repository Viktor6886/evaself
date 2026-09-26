/**
 * Инструменты OSINT для Евы.
 *
 * Инструменты просто зарегистрированы: когда их вызвать, решает Letta
 * (инвариант 17). Условия, без которых исследование не начинается, —
 * явная просьба, заявленная цель, лимит, аудит — проверяет сервис, а не
 * модель: описание инструмента говорит о них, чтобы модель не тратила ход
 * на заведомый отказ.
 *
 * Данные о третьих лицах не пишутся в память. Описание инструмента
 * отчёта это оговаривает, а сам отчёт живёт в PostgreSQL со своим сроком
 * хранения (`docs/OSINT.md`).
 */

import { createHash, randomUUID } from "node:crypto";

import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { AgentRuntimeContext } from "../db.js";
import { objectSchema, optionalString, requiredString, text, type JsonObject, type ToolBuilder } from "../tools/tool-kit.js";
import { renderReport } from "./report.js";
import type { OsintService } from "./service.js";
import { IDENTIFIER_TYPES } from "./types.js";

const investigationId = (args: JsonObject): string => {
  const id = requiredString(args, "investigation_id", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("investigation_id: ожидается идентификатор исследования");
  return id;
};

function seedsOf(args: JsonObject): Array<{ type: string; value: string }> {
  const raw = args.seeds;
  if (!Array.isArray(raw)) throw new Error("seeds: ожидается список идентификаторов");
  return raw.map((item) => {
    const seed = item as { type?: unknown; value?: unknown };
    if (typeof seed?.type !== "string" || typeof seed?.value !== "string") {
      throw new Error("seeds: каждый элемент — {type, value}");
    }
    return { type: seed.type, value: seed.value };
  });
}

/**
 * Ключ идемпотентности из вызова инструмента. Идентификаторы conversation
 * и вызова дают SDK и Letta, их алфавит не наш — поэтому хэш. Без
 * идентификатора вызова ключ случайный: склеить два разных вызова в одно
 * исследование хуже, чем не узнать повтор.
 */
export function toolIdempotencyKey(conversationId: string, toolCallId: string | undefined): string {
  if (!toolCallId) return `tool:${randomUUID()}`;
  return `tool:${createHash("sha256").update(`${conversationId}\n${toolCallId}`).digest("hex").slice(0, 48)}`;
}

export class OsintToolFactory {
  constructor(private readonly service: Pick<OsintService, "create" | "status" | "report" | "cancel" | "search" | "list" | "delete">) {}

  build(tool: ToolBuilder): AnyAgentTool[] {
    return [
      tool(
        "osint_investigate",
        "Начать OSINT-исследование",
        [
          "Запускает фоновое исследование открытых источников о человеке или организации.",
          "Вызывай ТОЛЬКО по явной просьбе пользователя что-то найти или проверить и только с его целью своими словами (purpose): проверка контрагента, безопасность сделки, поиск собственного цифрового следа.",
          "Не запускай по собственной инициативе, для слежки за человеком, установления его местонахождения, «пробива» или поиска в утечках — такие просьбы вежливо отклоняй.",
          "seeds — известные идентификаторы: name, username, email, phone, domain, ip, asn, organization, tax_id, registration_number, url, social_account.",
          "Результат приходит не сразу: сообщи, что исследование идёт. Когда оно завершится, ты сама получишь служебное сообщение и перескажешь отчёт — напоминаний для проверки не ставь.",
        ].join(" "),
        objectSchema({
          query: text("Просьба пользователя своими словами."),
          purpose: text("Зачем это нужно пользователю, его словами. Без цели исследование не начнётся."),
          subject: { type: "string", enum: ["person", "organization"], description: "Кого исследуем." },
          seeds: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            description: "Известные идентификаторы субъекта.",
            items: objectSchema({
              type: { type: "string", enum: [...IDENTIFIER_TYPES], description: "Тип идентификатора." },
              value: text("Значение как его дал пользователь."),
            }, ["type", "value"]),
          },
          mode: { type: "string", enum: ["standard", "deep"], description: "deep — глубже и дольше; если пользователь просит подробнее или «максимум»." },
          city: text("Необязательно: город, если человек его назвал. Сильно сужает поиск по имени."),
          workplace: text("Необязательно: место работы или учёбы, если человек его назвал."),
        }, ["query", "purpose", "subject", "seeds"]),
        async (args, runtime: AgentRuntimeContext, toolCallId) => {
          const subject = args.subject === "organization" ? "organization" : "person";
          const created = await this.service.create({
            userId: runtime.userId,
            conversationId: runtime.conversationId,
            query: requiredString(args, "query", 4_000),
            purpose: requiredString(args, "purpose", 1_000),
            subject,
            seeds: seedsOf(args),
            mode: args.mode === "deep" ? "deep" : "standard",
            context: { city: optionalString(args, "city", 100), organization: optionalString(args, "workplace", 100) },
            // Один вызов инструмента — одно исследование: повтор хода
            // после сбоя вернёт то же исследование, а не второе.
            idempotencyKey: toolIdempotencyKey(runtime.conversationId, toolCallId),
          });
          return { ok: true, investigation_id: created.id, status: created.created ? "queued" : "already_created" };
        },
      ),
      tool(
        "osint_get_status",
        "Статус OSINT-исследования",
        "Только читает статус исследования: сколько идентификаторов обработано и осталось, сколько источников и запросов. Используй, когда пользователь спрашивает, как идёт исследование.",
        objectSchema({ investigation_id: text("Идентификатор исследования.") }, ["investigation_id"]),
        async (args, runtime: AgentRuntimeContext) =>
          await this.service.status(runtime.userId, investigationId(args)) ?? { ok: false, error: "Исследование не найдено" },
      ),
      tool(
        "osint_get_report",
        "Отчёт OSINT-исследования",
        [
          "Возвращает отчёт исследования с источниками и ограничениями.",
          "Пересказывай только то, что в отчёте, и всегда называй ограничения: аккаунт, найденный по нику, НЕ принадлежит человеку, пока отчёт не говорит confirmed/probable.",
          "Не сохраняй сведения о третьих лицах из отчёта в память (memory blocks, MemFS): отчёт хранится отдельно со своим сроком.",
        ].join(" "),
        objectSchema({ investigation_id: text("Идентификатор исследования.") }, ["investigation_id"]),
        async (args, runtime: AgentRuntimeContext) => {
          const report = await this.service.report(runtime.userId, investigationId(args));
          return report ? renderReport(report) : { ok: false, error: "Исследование не найдено" };
        },
      ),
      tool(
        "osint_list",
        "Мои OSINT-исследования",
        "Только читает последние исследования пользователя: идентификатор, статус, начало запроса. Используй, чтобы найти нужное исследование.",
        objectSchema({}),
        async (_args, runtime: AgentRuntimeContext) => await this.service.list(runtime.userId),
      ),
      tool(
        "osint_search_entity",
        "Поиск в собранных данных",
        "Ищет по уже собранным исследованиям пользователя — по имени, нику, домену, почте. Новых запросов во внешние источники не делает.",
        objectSchema({ query: text("Что искать: от 3 до 200 знаков.") }, ["query"]),
        async (args, runtime: AgentRuntimeContext) => await this.service.search(runtime.userId, requiredString(args, "query", 200)),
      ),
      tool(
        "osint_cancel",
        "Остановить OSINT-исследование",
        "Останавливает идущее исследование по просьбе пользователя. Собранное остаётся до удаления.",
        objectSchema({ investigation_id: text("Идентификатор исследования.") }, ["investigation_id"]),
        async (args, runtime: AgentRuntimeContext) => ({ cancelled: await this.service.cancel(runtime.userId, investigationId(args)) }),
      ),
      tool(
        "osint_delete",
        "Удалить OSINT-исследование",
        "Безвозвратно удаляет исследование и всё найденное, если это больше не нужно другим исследованиям. Только по явной просьбе пользователя.",
        objectSchema({
          investigation_id: text("Идентификатор исследования."),
          reason: text("Необязательно: почему удаляется."),
        }, ["investigation_id"]),
        async (args, runtime: AgentRuntimeContext) => {
          optionalString(args, "reason", 200);
          return { deleted: await this.service.delete(runtime.userId, investigationId(args)) };
        },
      ),
    ];
  }
}
