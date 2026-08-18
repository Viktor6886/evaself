/**
 * Маршруты дневника Mini App.
 *
 * Регистрируются под тем же префиксом `/public/v2`, что и остальные
 * разделы Mini App, и той же проверкой подписи: второго способа войти в
 * приложение не создаётся. Владелец берётся только из проверенного
 * `initData`; `user_id` из тела запроса не читается ни одним маршрутом.
 *
 * Выключенный флаг означает отсутствие маршрутов, а не пустые ответы:
 * пустой дневник и выключенный дневник — разные вещи, и человек не
 * должен принимать одно за другое.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Config } from "../../config.js";
import type { Database } from "../../db.js";
import { badRequest, unauthorized } from "../../errors.js";
import { ChannelLinkService } from "../../channels/channel-links.js";
import type { TelegramWebAppUser } from "../telegram-webapp-auth.js";
import { askEva, type AskModelConclusion } from "./ask.js";
import { buildDiscussionRequest } from "./discussion.js";
import { positiveId } from "./input.js";
import { JournalService } from "./service.js";
import { weeklyReview } from "./weekly-review.js";

interface JournalRequest extends FastifyRequest {
  telegramWebAppUser?: TelegramWebAppUser;
}

interface OwnedUser {
  id: number;
  timezone: string;
}

export interface JournalRoutesInput {
  config: Config;
  db: Database;
  /** Вывод модели для «Спросить Еву». Отсутствует — раздел честно пуст. */
  askModel?: AskModelConclusion;
}

/**
 * Маршруты регистрируются ВНУТРИ уже защищённой области: вызывающий
 * передаёт экземпляр, у которого хук проверки подписи уже стоит. Свой
 * второй хук здесь не ставится намеренно — два независимых места
 * проверки подписи рано или поздно разойдутся.
 */
export function registerJournalRoutes(
  app: FastifyInstance,
  input: JournalRoutesInput,
): void {
  const journal = new JournalService(input.db, {
    voiceRetentionDays: input.config.journalVoiceRetentionDays,
  });
  const channels = new ChannelLinkService(input.db);

  app.get("/journal", async (request) => await scoped(input.db, request, async (user) => ({
    entries: await journal.list(user.id, {
      limit: queryInteger(request, "limit", 50),
      days: queryInteger(request, "days", 90),
    }),
  })));

  app.post("/journal", async (request, reply) => await scoped(input.db, request, async (user) => {
    // Сохранение без ИИ: здесь нет ни одного обращения к модели.
    const entry = await journal.create(user.id, user.timezone, body(request));
    return reply.status(201).send({ entry });
  }));

  app.patch("/journal/:id", async (request) => await scoped(input.db, request, async (user) => ({
    entry: await journal.update(
      user.id,
      positiveId((request.params as { id?: string }).id, "записи"),
      body(request),
    ),
  })));

  app.delete("/journal/:id", async (request) => await scoped(input.db, request, async (user) => ({
    deleted: await journal.remove(
      user.id,
      positiveId((request.params as { id?: string }).id, "записи"),
    ),
  })));

  /**
   * Отдать запись Еве — отдельное действие, а не побочный эффект
   * сохранения. Ответ содержит готовое обращение и признак кризиса:
   * кризисная маршрутизация уже выполнена до всякого выбора модели.
   */
  app.post("/journal/:id/discuss", async (request) => await scoped(input.db, request, async (user) => {
    const entryId = positiveId((request.params as { id?: string }).id, "записи");
    const detailed = body(request).detailed === true;
    const entry = await journal.get(user.id, entryId);
    const discussion = buildDiscussionRequest(entry, { detailed });
    const shared = await journal.markShared(user.id, entryId);
    // Связь с каналом ставится сразу: ход появится позже, но сообщение
    // Mini App уже принадлежит этому пользователю и этой записи, и по
    // нему обе стороны найдут друг друга.
    await channels.link(user.id, {
      channel: "miniapp",
      channelMessageId: `journal:${entryId}`,
      entryId,
    });
    return { entry: shared, discussion };
  }));

  app.get("/journal/people", async (request) => await scoped(input.db, request, async (user) => ({
    people: await journal.listPeople(user.id),
  })));

  app.patch("/journal/people/:id", async (request) => await scoped(input.db, request, async (user) => ({
    person: await journal.updatePerson(
      user.id,
      positiveId((request.params as { id?: string }).id, "карточки"),
      body(request),
    ),
  })));

  app.delete("/journal/people/:id", async (request) => await scoped(input.db, request, async (user) => ({
    deleted: await journal.removePerson(
      user.id,
      positiveId((request.params as { id?: string }).id, "карточки"),
    ),
  })));

  app.post("/journal/voice", async (request, reply) => await scoped(input.db, request, async (user) => {
    const voice = await journal.attachVoice(user.id, body(request));
    return reply.status(201).send({ voice });
  }));

  app.post("/journal/voice/:id/transcript", async (request) => await scoped(input.db, request, async (user) => {
    const text = body(request).transcript;
    if (typeof text !== "string") throw badRequest("Расшифровка: требуется текст");
    return {
      voice: await journal.setTranscript(
        user.id,
        positiveId((request.params as { id?: string }).id, "голосовой заметки"),
        text,
      ),
    };
  }));

  app.post("/journal/voice/expire", async (request) => await scoped(input.db, request, async (user) => (
    await journal.expireVoiceNotes(user.id)
  )));

  app.get("/journal/weekly-review", async (request) => await scoped(input.db, request, async (user) => (
    await weeklyReview(input.db, user, { days: queryInteger(request, "days", 7) })
  )));

  app.post("/journal/ask", async (request) => await scoped(input.db, request, async (user) => (
    await askEva(input.db, user, body(request), {
      ...(input.askModel ? { model: input.askModel } : {}),
      // Внешние источники читаются из своих таблиц. Если подсистема
      // выключена, таблицы пусты — но «пусто» и «выключено» человек
      // различать не обязан, поэтому состояние передаётся явно.
      externalEnabled: input.config.researchOrchestratorEnabled,
    })
  )));

  app.get("/journal/channels", async (request) => await scoped(input.db, request, async (user) => ({
    activity: await channels.activity(user.id, queryInteger(request, "limit", 20)),
  })));
}

async function scoped<T>(
  db: Database,
  request: FastifyRequest,
  work: (user: OwnedUser) => Promise<T>,
): Promise<T> {
  const telegramId = publicUser(request).id;
  return await db.withUserScope({ telegramId, label: "miniapp.journal" }, async () => {
    const { rows } = await db.query<{ id: string; timezone: string }>(
      "SELECT id::text, timezone FROM users WHERE telegram_id = $1",
      [telegramId],
    );
    if (!rows[0]) throw unauthorized("Пользователь Telegram не найден");
    const user = { id: Number(rows[0].id), timezone: rows[0].timezone };
    db.bindScopeUserId(user.id);
    return await work(user);
  });
}

function publicUser(request: FastifyRequest): TelegramWebAppUser {
  const user = (request as JournalRequest).telegramWebAppUser;
  if (!user) throw unauthorized("Сессия Telegram Mini App не проверена");
  return user;
}

function body(request: FastifyRequest): Record<string, unknown> {
  return request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
}

function queryInteger(request: FastifyRequest, name: string, fallback: number): number {
  const raw = (request.query as Record<string, unknown> | undefined)?.[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
