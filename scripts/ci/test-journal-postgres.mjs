/**
 * Дневник Mini App на НАСТОЯЩЕЙ базе.
 *
 * Поддельная база в тестах сервиса не исполняет ни каскады, ни
 * `ON CONFLICT (user_id, normalized)`, ни `NOT EXISTS` по соседней
 * таблице — а именно на них держатся два требования шага 25:
 *
 *   • правка и удаление распространяются на производные данные: вместе с
 *     записью исчезают связи, упоминания и голосовая заметка, а карточка
 *     человека без единого упоминания перестаёт существовать;
 *   • совпадение отображаемых имён не объединяет учётные записи: два
 *     пользователя с одинаковым «Мама» получают две разные карточки.
 *
 * Скрипт заводит собственных пользователей, проверяет и убирает за
 * собой. Соседние строки в базе он не трогает.
 */

// Путь явный: скрипт лежит вне пакета сервиса, и разрешение голого
// имени пошло бы мимо его node_modules.
import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { JournalService } from "../../eva-agent-service/dist/public/journal/service.js";
import { ChannelLinkService } from "../../eva-agent-service/dist/channels/channel-links.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Границу арендатора здесь не подменяем и не выключаем: она живёт в
 * `Database`, а этот скрипт проверяет семантику схемы. Владелец в каждом
 * запросе сервиса задан явно параметром — это видно в самих запросах.
 */
const db = {
  query: (sql, values) => pool.query(sql, values),
  transaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
};

function assert(condition, message) {
  if (!condition) {
    console.error(`::error::${message}`);
    throw new Error(message);
  }
  console.log(`  ✔ ${message}`);
}

const TELEGRAM_IDS = [-90520001, -90520002];

const user = async (telegramId) => Number((await pool.query(
  `INSERT INTO users(telegram_id, first_name, timezone)
   VALUES ($1, 'Мария', 'Europe/Moscow')
   ON CONFLICT(telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name
   RETURNING id`,
  [telegramId],
)).rows[0].id);

try {
  const journal = new JournalService(db, { voiceRetentionDays: 30 });
  const channels = new ChannelLinkService(db);
  const [first, second] = [await user(TELEGRAM_IDS[0]), await user(TELEGRAM_IDS[1])];

  // ------------------------------------------------------------------
  // Запись сохраняется без ИИ и со всеми связями
  // ------------------------------------------------------------------
  // Активная цель обязана быть подтверждённой человеком —
  // `goals_activation_check`. Ставить статус в обход подтверждения
  // нельзя даже во вспомогательных данных теста.
  const goalId = Number((await pool.query(
    `INSERT INTO goals(user_id, title, status, priority, user_confirmed)
     VALUES ($1, 'CI дневник', 'active', 3, true) RETURNING id`,
    [first],
  )).rows[0].id);

  const entry = await journal.create(first, "Europe/Moscow", {
    content: "Поговорила с мамой о переезде",
    title: "Разговор",
    mood: "good",
    energy: 7,
    people: ["Мама", "  мама  "],
    links: [{ target_type: "goal", target_id: goalId }],
  });
  assert(entry.share_state === "saved", "новая запись не отдана Еве");
  assert(entry.people.length === 1, "повторное имя в одной записи склеивается в одну карточку");
  assert(entry.links.length === 1, "связь с целью сохранена");

  // ------------------------------------------------------------------
  // Одинаковое имя у разных людей не объединяет учётные записи
  // ------------------------------------------------------------------
  const foreign = await journal.create(second, "Europe/Moscow", {
    content: "Своя запись",
    people: ["Мама"],
  });
  assert(
    foreign.people[0].id !== entry.people[0].id,
    "одинаковое имя у двух пользователей даёт РАЗНЫЕ карточки",
  );
  assert(
    (await journal.listPeople(second)).length === 1,
    "чужие карточки людей в список не попадают",
  );

  // ------------------------------------------------------------------
  // Голосовая заметка: срок ставится сразу, расшифровка переживает файл
  // ------------------------------------------------------------------
  const voice = await journal.attachVoice(first, {
    media_key: "ci-journal-voice-1",
    duration_ms: 4_200,
    entry_id: Number(entry.id),
  });
  assert(new Date(voice.expires_at) > new Date(), "срок хранения заметки в будущем");
  const transcribed = await journal.setTranscript(first, Number(voice.id), "текст расшифровки");
  assert(transcribed.status === "transcribed", "расшифровка меняет состояние заметки");

  await pool.query(
    "UPDATE journal_voice_notes SET expires_at = now() - interval '1 day' WHERE id = $1",
    [Number(voice.id)],
  );
  const expired = await journal.expireVoiceNotes(first);
  assert(expired.expired === 1, "просроченная заметка помечается истёкшей");
  const afterExpiry = (await pool.query(
    "SELECT status, transcript FROM journal_voice_notes WHERE id = $1",
    [Number(voice.id)],
  )).rows[0];
  assert(afterExpiry.status === "expired", "истёкшая заметка не исчезает молча");
  assert(
    afterExpiry.transcript === "текст расшифровки",
    "расшифровка переживает истечение аудио",
  );

  // ------------------------------------------------------------------
  // Действие видно в обоих каналах
  // ------------------------------------------------------------------
  await channels.link(first, {
    channel: "telegram",
    channelMessageId: "ci-msg-1",
    turnId: "ci-turn-1",
    conversationId: "ci-conv-1",
    entryId: Number(entry.id),
  });
  await channels.link(first, {
    channel: "miniapp",
    channelMessageId: `journal:${entry.id}`,
    turnId: "ci-turn-1",
    entryId: Number(entry.id),
  });
  const linked = await channels.byTurn(first, "ci-turn-1");
  assert(linked.length === 2, "один ход связан с сообщениями обоих каналов");
  assert(
    new Set(linked.map((row) => row.channel)).size === 2,
    "оба канала указывают на один и тот же ход",
  );
  // Повторная привязка того же сообщения не удваивает строку: на этом
  // держится безопасность повторной доставки.
  await channels.link(first, {
    channel: "telegram",
    channelMessageId: "ci-msg-1",
    turnId: "ci-turn-1",
  });
  assert(
    (await channels.byTurn(first, "ci-turn-1")).length === 2,
    "повторная привязка того же сообщения ничего не дублирует",
  );
  const activity = await channels.activity(first, 20);
  assert(
    activity.some((item) => item.kind === "journal_entry")
    && activity.some((item) => item.kind === "message"),
    "лента показывает действия обоих каналов одному владельцу",
  );
  assert(
    (await channels.activity(second, 20)).every((item) => !item.reference.endsWith(`:${entry.id}`)),
    "чужая запись в ленту второго пользователя не попадает",
  );

  // ------------------------------------------------------------------
  // Удаление распространяется на производные данные
  // ------------------------------------------------------------------
  const personId = Number(entry.people[0].id);
  const deleted = await journal.remove(first, Number(entry.id));
  assert(deleted.links === 1, "связь с целью удалена вместе с записью");
  assert(deleted.people_links === 1, "упоминание человека удалено вместе с записью");
  assert(deleted.people_removed === 1, "карточка без упоминаний перестала существовать");
  assert(deleted.voice_notes === 1, "голосовая заметка удалена вместе с записью");
  assert(deleted.channel_links === 2, "связи каналов удалены вместе с записью");

  for (const [table, column] of [
    ["journal_entry_links", "entry_id"],
    ["journal_entry_people", "entry_id"],
    ["journal_voice_notes", "entry_id"],
    ["channel_message_links", "entry_id"],
  ]) {
    const left = Number((await pool.query(
      `SELECT count(*) n FROM ${table} WHERE ${column} = $1`,
      [Number(entry.id)],
    )).rows[0].n);
    assert(left === 0, `${table} не хранит производные данные удалённой записи`);
  }
  const personLeft = Number((await pool.query(
    "SELECT count(*) n FROM journal_people WHERE id = $1",
    [personId],
  )).rows[0].n);
  assert(personLeft === 0, "осиротевшая карточка человека удалена");

  // Чужая запись при этом на месте: удаление не вышло за границу.
  assert(
    Number((await pool.query(
      "SELECT count(*) n FROM journal_entries WHERE user_id = $1",
      [second],
    )).rows[0].n) === 1,
    "удаление не задело дневник другого пользователя",
  );

  // ------------------------------------------------------------------
  // Чужую запись удалить нельзя
  // ------------------------------------------------------------------
  let refused = false;
  try {
    await journal.remove(first, Number(foreign.id));
  } catch (error) {
    refused = String(error?.message ?? "").includes("не найдена");
  }
  assert(refused, "чужая запись не удаляется подменой идентификатора");

  console.log("журнал: семантика хранения на PostgreSQL подтверждена");
} finally {
  // Пользователи удаляются каскадом вместе со всем, что скрипт создал.
  await pool.query("DELETE FROM users WHERE telegram_id = ANY($1::bigint[])", [TELEGRAM_IDS]);
  await pool.end();
}
