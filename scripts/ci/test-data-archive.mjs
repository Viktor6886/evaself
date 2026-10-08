/**
 * Архив данных человека на НАСТОЯЩЕЙ базе (docs/data-archive.md).
 *
 * Поддельная база в тестах сервиса не исполняет ни `ON CONFLICT ... DO
 * UPDATE ... WHERE`, ни ограничения таблиц, ни хэш содержания в SQL, а
 * загрузка архива держится именно на них:
 *
 *   • выгрузка проходит через настоящую границу арендатора (`Database`
 *     с проверкой каждого запроса) и не берёт чужих строк;
 *   • архив, загруженный обратно тому же человеку, ничего не добавляет и
 *     ничего не меняет — ни одна существующая строка не переписана;
 *   • другой человек получает все записи, связи цель → результат →
 *     задача и запись дневника → люди сохраняются;
 *   • прошедшее напоминание из архива не срабатывает, повторяющееся
 *     ждёт следующего срока, а поручение Еве приходит выключенным;
 *   • повторная загрузка идемпотентна, предпросмотр ничего не пишет.
 *
 * Скрипт заводит собственных пользователей и убирает за собой.
 */

import { createHash } from "node:crypto";

import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { Database } from "../../eva-agent-service/dist/db.js";
import { DataArchiveService } from "../../eva-agent-service/dist/archive/service.js";
import { readWorkbook } from "../../eva-agent-service/dist/archive/xlsx-reader.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL не задан");
const admin = new pg.Pool({ connectionString: url });
const db = new Database(url);
await db.connect();

function assert(condition, message) {
  if (!condition) {
    console.error(`::error::${message}`);
    throw new Error(message);
  }
  console.log(`  ✔ ${message}`);
}

const NOW = new Date("2026-10-07T09:00:00Z");
const ALICE = 9_870_001;
const BOB = 9_870_002;
const CAROL = 9_870_003;
const DAVE = 9_870_004;
const sent = [];
const service = (telegramIdNow = NOW) => new DataArchiveService({
  db,
  telegram: { sendDocument: async (chatId, bytes, filename) => { sent.push({ chatId, bytes: Buffer.from(bytes), filename }); } },
  flags: { enabled: () => true, memory: () => true },
  memory: { read: async () => ({ human: "Любит горы. Гипотеза: устаёт от шума.", current_state: "Готовится к марафону." }) },
  now: () => telegramIdNow,
});

async function cleanup() {
  await admin.query("DELETE FROM users WHERE telegram_id = ANY($1::bigint[])", [[ALICE, BOB, CAROL, DAVE]]);
}

/** Снимок пользовательских таблиц: число строк и их содержимое без служебных полей. */
async function snapshot(userId) {
  const tables = {
    goals: "SELECT id, parent_goal_id, title, status, user_confirmed, updated_at FROM goals",
    goal_results: "SELECT id, goal_id, parent_result_id, title, updated_at FROM goal_results",
    tasks: "SELECT id, title, status, kind, next_run_at, last_run_at, reminders_enabled, goal_id, goal_result_id, updated_at FROM tasks",
    journal_entries: "SELECT id, local_date, content, share_state, updated_at FROM journal_entries",
    journal_people: "SELECT id, display_name, relation, updated_at FROM journal_people",
    journal_entry_people: "SELECT entry_id, person_id FROM journal_entry_people",
    eva_notes: "SELECT id, title, length(content) AS length, updated_at FROM eva_notes",
    user_checkins: "SELECT id, local_date, mood, updated_at FROM user_checkins",
    budget_entries: "SELECT id, occurred_on, amount_minor, updated_at FROM budget_entries",
    eva_decisions: "SELECT id, question, updated_at FROM eva_decisions",
    onboarding_fields: "SELECT id, field_key, field_value, status, updated_at FROM onboarding_fields",
    user_north: "SELECT desired_direction, updated_at FROM user_north",
    user_preferences: "SELECT response_mode, agent_mode, updated_at FROM user_preferences",
  };
  const result = {};
  for (const [table, sql] of Object.entries(tables)) {
    const { rows } = await admin.query(`${sql} WHERE user_id = $1 ORDER BY 1`, [userId]);
    result[table] = rows;
  }
  const { rows } = await admin.query("SELECT first_name, last_name, city, timezone, updated_at FROM users WHERE id = $1", [userId]);
  result.users = rows;
  return result;
}

await cleanup();
try {
  const { rows: [alice] } = await admin.query(
    `INSERT INTO users (telegram_id, first_name, timezone, timezone_source, city)
     VALUES ($1, 'Алиса', 'Europe/Moscow', 'iana', 'Москва') RETURNING id`, [ALICE]);
  const { rows: [bob] } = await admin.query(
    "INSERT INTO users (telegram_id, first_name) VALUES ($1, 'Боб') RETURNING id", [BOB]);
  const aliceId = Number(alice.id);
  const bobId = Number(bob.id);

  // ---- данные Алисы ---------------------------------------------------
  await admin.query(`INSERT INTO user_preferences (user_id, response_mode, agent_mode) VALUES ($1, 'both', 'coach')`, [aliceId]);
  await admin.query(
    `INSERT INTO onboarding_fields (user_id, field_key, field_value, status, sensitivity)
     VALUES ($1, 'preferred_name', 'Аля', 'confirmed', 'normal')`, [aliceId]);
  await admin.query(
    `INSERT INTO onboarding_fields (user_id, field_key, field_json, status, sensitivity)
     VALUES ($1, 'interests', '["бег", "горы"]'::jsonb, 'candidate', 'normal')`, [aliceId]);
  // Отказ отвечать — не ответ: собственный архив не должен возвращаться
  // с «ошибкой» в этой строке.
  await admin.query(
    `INSERT INTO onboarding_fields (user_id, field_key, status, declined_at, sensitivity)
     VALUES ($1, 'work_schedule', 'declined', now(), 'normal')`, [aliceId]);
  await admin.query(
    `INSERT INTO user_north (user_id, desired_direction, values, user_confirmed)
     VALUES ($1, 'Здоровье и спокойствие', '["здоровье", "семья"]'::jsonb, true)`, [aliceId]);
  const { rows: [parentGoal] } = await admin.query(
    `INSERT INTO goals (user_id, title, status, user_confirmed, success_criteria)
     VALUES ($1, 'Пробежать марафон', 'active', true, '["42 км", "без травм"]'::jsonb) RETURNING id`, [aliceId]);
  const { rows: [childGoal] } = await admin.query(
    `INSERT INTO goals (user_id, parent_goal_id, title, status) VALUES ($1, $2, 'Набрать базу', 'draft') RETURNING id`,
    [aliceId, parentGoal.id]);
  const { rows: [result] } = await admin.query(
    `INSERT INTO goal_results (user_id, goal_id, title, status) VALUES ($1, $2, 'Полумарафон', 'in_progress') RETURNING id`,
    [aliceId, parentGoal.id]);
  await admin.query(
    `INSERT INTO goal_results (user_id, goal_id, parent_result_id, title) VALUES ($1, $2, $3, 'Десятка')`,
    [aliceId, parentGoal.id, result.id]);
  // Прошедшее разовое, будущее разовое, повторяющееся и поручение Еве.
  await admin.query(
    `INSERT INTO tasks (user_id, title, remind_at, next_run_at, timezone, goal_id, goal_result_id)
     VALUES ($1, 'Купить кроссовки', '2026-09-01T07:00:00Z', '2026-09-01T07:00:00Z', 'Europe/Moscow', $2, $3)`,
    [aliceId, parentGoal.id, result.id]);
  await admin.query(
    `INSERT INTO tasks (user_id, title, remind_at, next_run_at, timezone)
     VALUES ($1, 'Записаться к врачу', '2026-12-01T07:00:00Z', '2026-12-01T07:00:00Z', 'Europe/Moscow')`, [aliceId]);
  await admin.query(
    `INSERT INTO tasks (user_id, title, cron_expression, repeat_enabled, timezone, next_run_at)
     VALUES ($1, 'Утренняя пробежка', '0 7 * * *', true, 'Europe/Moscow', '2026-10-08T04:00:00Z')`, [aliceId]);
  await admin.query(
    `INSERT INTO tasks (user_id, title, kind, remind_at, next_run_at, timezone)
     VALUES ($1, 'Найти лучший план тренировок', 'action', '2026-12-02T07:00:00Z', '2026-12-02T07:00:00Z', 'Europe/Moscow')`,
    [aliceId]);
  await admin.query(`INSERT INTO tasks (user_id, title, status, completed_at) VALUES ($1, 'Старая задача', 'done', now())`, [aliceId]);
  // «Напомни через десять минут» хранит секунды, а файл — минуты: тот же
  // архив, загруженный тому же человеку, не должен задвоить такую задачу.
  await admin.query(
    `INSERT INTO tasks (user_id, title, remind_at, next_run_at, timezone)
     VALUES ($1, 'Выпить воды', '2026-12-03T07:00:42.123Z', '2026-12-03T07:00:42.123Z', 'Europe/Moscow')`, [aliceId]);
  // Запись длиннее ячейки Excel: сохранена раньше другим путём.
  await admin.query(
    `INSERT INTO journal_entries (user_id, local_date, content) VALUES ($1, '2026-09-01', $2)`,
    [aliceId, `${"Длинный день. ".repeat(3_000)}конец`]);
  await admin.query(
    `INSERT INTO tasks (user_id, title, repeat_enabled, timezone) VALUES ($1, 'Повтор без расписания', true, 'Europe/Moscow')`,
    [aliceId]);
  const { rows: [entry] } = await admin.query(
    `INSERT INTO journal_entries (user_id, local_date, title, content, mood, energy)
     VALUES ($1, '2026-10-01', 'Пробежка', E'Пробежала 10 км.\r\nУстала, но довольна.', 'good', 7) RETURNING id`, [aliceId]);
  const { rows: [mom] } = await admin.query(
    `INSERT INTO journal_people (user_id, display_name, normalized, relation) VALUES ($1, 'Мама', 'мама', 'мама') RETURNING id`, [aliceId]);
  await admin.query(`INSERT INTO journal_entry_people (user_id, entry_id, person_id) VALUES ($1, $2, $3)`, [aliceId, entry.id, mom.id]);
  await admin.query(
    `INSERT INTO eva_notes (user_id, title, content, tags) VALUES ($1, 'Длинная', $2, ARRAY['бег','план'])`,
    [aliceId, `${"Абзац про тренировки. ".repeat(3_000)}конец`]);
  await admin.query(
    `INSERT INTO eva_notes (user_id, title, content) VALUES ($1, '=формула?', '_x000D_ буквально и <тег>')`, [aliceId]);
  await admin.query(
    `INSERT INTO user_checkins (user_id, local_date, mood, energy, tension, note) VALUES ($1, '2026-10-02', 'neutral', 5, 4, 'ок')`,
    [aliceId]);
  await admin.query(
    `INSERT INTO budget_entries (user_id, occurred_on, entry_type, amount_minor, category, store)
     VALUES ($1, '2026-10-03', 'expense', 1234550, 'спорт', 'Спортмастер')`, [aliceId]);
  await admin.query(
    `INSERT INTO eva_decisions (user_id, question, options, confidence)
     VALUES ($1, 'Бежать ли весной?', $2::jsonb, 70)`, [aliceId, JSON.stringify(["да", "нет, осенью\nесли не успею"])]);
  await admin.query(
    `INSERT INTO work_blocks (user_id, goal_id, intention, status) VALUES ($1, $2, 'Интервалы', 'planned')`,
    [aliceId, childGoal.id]);
  // Две одинаковые покупки — две строки: на чистом аккаунте их тоже две.
  for (let index = 0; index < 2; index += 1) {
    await admin.query(
      `INSERT INTO budget_entries (user_id, occurred_on, entry_type, amount_minor, category, store)
       VALUES ($1, '2026-10-04', 'expense', 20000, 'здоровье', 'Аптека')`, [aliceId]);
  }
  // Края текста — неразрывный и идеографический пробелы: повторная загрузка
  // не должна счесть такую заметку новой.
  await admin.query(`INSERT INTO eva_notes (user_id, title, content) VALUES ($1, 'Края', $2)`,
    [aliceId, "\u00a0Текст с особыми краями\u3000"]);
  // Чувствительное поле, подтверждённое когда-то: из файла — предположением.
  // Единственный пункт с запятой внутри должен вернуться одним пунктом.
  await admin.query(
    `INSERT INTO onboarding_fields (user_id, field_key, field_json, status, sensitivity)
     VALUES ($1, 'recovery_methods', '["прогулка, сон"]'::jsonb, 'confirmed', 'sensitive')`, [aliceId]);
  // Перевод строки `\r\n` ровно на стыке частей ячейки (32 000 знаков).
  await admin.query(`INSERT INTO eva_notes (user_id, title, content) VALUES ($1, 'Стык', $2)`,
    [aliceId, `${"а".repeat(31_999)}\r\n${"б".repeat(10)}`]);
  // Имя с неразрывным пробелом: у JavaScript и PostgreSQL разное мнение о
  // том, пробел ли это, — предпросмотр обязан считать, как запись.
  await admin.query(
    `INSERT INTO journal_people (user_id, display_name, normalized) VALUES ($1, $2, btrim(lower(regexp_replace($2, '\\s+', ' ', 'g'))))`,
    [aliceId, "Анна\u00a0Ли"]);
  // Повтор каждые пять минут из файла не принимается.
  await admin.query(
    `INSERT INTO tasks (user_id, title, cron_expression, repeat_enabled, timezone, next_run_at)
     VALUES ($1, 'Слишком часто', '*/5 * * * *', true, 'Europe/Moscow', '2026-10-07T09:05:00Z')`, [aliceId]);
  // Строка Боба: выгрузка Алисы обязана её не увидеть.
  await admin.query(`INSERT INTO eva_notes (user_id, title, content) VALUES ($1, 'Секрет Боба', 'не для Алисы')`, [bobId]);
  // У Боба есть «Анна Ли» с обычным пробелом — для базы это другой человек.
  await admin.query(
    `INSERT INTO journal_people (user_id, display_name, normalized) VALUES ($1, 'Анна Ли', 'анна ли')`, [bobId]);

  // ---- выгрузка --------------------------------------------------------
  const exported = await service().export(ALICE);
  assert(sent.length === 1 && sent[0].chatId === ALICE, "архив отправлен Алисе в её чат");
  assert(exported.filename === "eva-archive-2026-10-07.xlsx", "имя файла — дата по поясу человека");
  const archive = sent[0].bytes;
  const book = await readWorkbook(archive);
  const names = book.sheets.map((sheet) => sheet.name);
  assert(names[0] === "О файле" && names.includes("Задачи и напоминания") && names.includes("Память Евы"),
    "в книге лист «О файле», задачи и память");
  const flat = JSON.stringify(book);
  assert(!flat.includes("Секрет Боба"), "чужая заметка в архив не попала");
  assert(flat.includes("Любит горы"), "память Евы выгружена по флагу");
  const aliceBefore = await snapshot(aliceId);

  // ---- обратно тому же человеку: ничего не добавляется и не меняется ---
  const mark = createHash("sha256").update(archive).digest("hex");
  const again = await service().apply(ALICE, archive, mark);
  assert(again.added_total === 0, `повторная загрузка тому же человеку ничего не добавила (${again.added_total})`);
  assert(again.existing_total > 10, "все записи узнаны как уже существующие");
  assert(JSON.stringify(await snapshot(aliceId)) === JSON.stringify(aliceBefore), "ни одна строка Алисы не изменилась");
  assert(again.memory_handoff && again.memory_handoff.includes("Готовится к марафону"), "память предлагается передать Еве");
  assert(again.error_count === 0, `собственный архив загружается без ошибок строк: ${JSON.stringify(again.errors)}`);

  // ---- другому человеку: предпросмотр ничего не пишет --------------------
  const bobBefore = await snapshot(bobId);
  // Предпросмотр идёт в транзакции только для чтения: любая вставка в нём
  // упала бы с ошибкой PostgreSQL, а не тихо откатилась.
  const preview = await service().preview(BOB, archive);
  assert(preview.applied === false && preview.added_total > 15, `предпросмотр насчитал добавления (${preview.added_total})`);
  assert(JSON.stringify(await snapshot(bobId)) === JSON.stringify(bobBefore), "предпросмотр ничего не записал");
  assert(preview.errors.length === 1 && /чаще раза/.test(preview.errors[0].message),
    `единственная ошибка — слишком частый повтор: ${JSON.stringify(preview.errors)}`);
  assert(preview.active_reminders === 3, `предпросмотр называет напоминания, которые начнут срабатывать (${preview.active_reminders})`);

  // Загрузка уже идёт (блокировка взята другим соединением) — отказ сразу, без ожидания.
  const holder = await admin.connect();
  let refused = false;
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`evaself.archive.import:${bobId}`]);
    const started = Date.now();
    try {
      await service().apply(BOB, archive, createHash("sha256").update(archive).digest("hex"));
    } catch (error) {
      refused = error?.statusCode === 409 && Date.now() - started < 5_000;
    }
  } finally {
    await holder.query("ROLLBACK");
    holder.release();
  }
  assert(refused, "вторая загрузка того же человека отклонена сразу (409)");

  let changed = false;
  try {
    await service().apply(BOB, Buffer.concat([archive, Buffer.from([0])]), preview.file_sha256);
  } catch (error) {
    changed = error?.statusCode === 409;
  }
  assert(changed, "запись другого файла после предпросмотра отклонена (409)");

  const applied = await service().apply(BOB, archive, preview.file_sha256);
  assert(applied.added_total === preview.added_total, "запись добавила ровно то, что обещал предпросмотр");
  assert(applied.paused_actions === 1, "поручение Еве из архива пришло выключенным");
  const bobAfter = await snapshot(bobId);
  const goals = bobAfter.goals;
  const marathon = goals.find((goal) => goal.title === "Пробежать марафон");
  const base = goals.find((goal) => goal.title === "Набрать базу");
  assert(marathon && marathon.status === "active" && marathon.user_confirmed, "активная подтверждённая цель осталась активной");
  assert(base && String(base.parent_goal_id) === String(marathon.id), "подцель связана с новой целью Боба");
  const halfMarathon = bobAfter.goal_results.find((item) => item.title === "Полумарафон");
  const ten = bobAfter.goal_results.find((item) => item.title === "Десятка");
  assert(halfMarathon && String(halfMarathon.goal_id) === String(marathon.id), "результат связан с целью");
  assert(ten && String(ten.parent_result_id) === String(halfMarathon.id), "вложенный результат связан с родителем");
  const tasks = Object.fromEntries(bobAfter.tasks.map((task) => [task.title, task]));
  assert(String(tasks["Купить кроссовки"].goal_result_id) === String(halfMarathon.id), "задача связана с результатом цели");
  assert(tasks["Купить кроссовки"].last_run_at?.getTime() === tasks["Купить кроссовки"].next_run_at?.getTime(),
    "прошедшее напоминание помечено отработавшим");
  assert(tasks["Записаться к врачу"].last_run_at === null && tasks["Записаться к врачу"].next_run_at.toISOString() === "2026-12-01T07:00:00.000Z",
    "будущее напоминание ждёт своего срока");
  assert(tasks["Утренняя пробежка"].next_run_at.toISOString() === "2026-10-08T04:00:00.000Z",
    "повторяющаяся задача ждёт следующего утра по поясу задачи");
  assert(tasks["Найти лучший план тренировок"].reminders_enabled === false, "поручение Еве выключено");
  const { rows: due } = await admin.query(
    `SELECT id FROM tasks
      WHERE user_id = $1 AND status IN ('open', 'in_progress') AND reminders_enabled
        AND COALESCE(next_run_at, remind_at, due_at) <= $2
        AND (last_run_at IS NULL OR last_run_at < COALESCE(next_run_at, remind_at, due_at))`,
    [bobId, NOW]);
  assert(due.length === 0, "после загрузки ни одна задача не наступила сразу");
  const note = bobAfter.eva_notes.find((item) => item.title === "Длинная");
  assert(note && Number(note.length) === aliceBefore.eva_notes.find((item) => item.title === "Длинная").length,
    "длинная заметка вернулась целиком через столбцы-продолжения");
  assert(bobAfter.journal_entry_people.length === 1, "запись дневника связана с человеком");
  assert(bobAfter.journal_entries[0].share_state === "saved", "запись дневника вернулась сохранённой");
  assert(bobAfter.users[0].first_name === "Боб" && bobAfter.users[0].city === "Москва",
    "профиль: имя не перезаписано, пустой город заполнен");
  assert(bobAfter.users[0].timezone === "Europe/Moscow", "пояс по умолчанию заполнен из архива");
  assert(bobAfter.user_preferences[0]?.response_mode === "both", "настройки созданы, раз их не было");
  assert(bobAfter.onboarding_fields.length === 3, "ответы анкеты добавлены, отказ отвечать — нет");
  const { rows: [methods] } = await admin.query(
    "SELECT field_json FROM onboarding_fields WHERE user_id = $1 AND field_key = 'recovery_methods'", [bobId]);
  assert(JSON.stringify(methods?.field_json) === JSON.stringify(["прогулка, сон"]),
    `пункт анкеты с запятой вернулся одним пунктом: ${JSON.stringify(methods?.field_json)}`);
  const { rows: [seam] } = await admin.query("SELECT content FROM eva_notes WHERE user_id = $1 AND title = 'Стык'", [bobId]);
  assert(seam?.content === `${"а".repeat(31_999)}\n${"б".repeat(10)}`, "перевод строки на стыке частей ячейки не задвоился");
  assert(bobAfter.journal_people.filter((item) => item.display_name.startsWith("Анна")).length === 2,
    "«Анна Ли» с неразрывным пробелом — отдельная карточка, как и в предпросмотре");
  assert(bobAfter.onboarding_fields.find((item) => item.field_key === "recovery_methods")?.status === "candidate",
    "чувствительное поле из файла пришло предположением");
  assert(bobAfter.budget_entries.filter((item) => Number(item.amount_minor) === 20000).length === 2,
    "две одинаковые покупки на чистом аккаунте — две записи");
  assert(!bobAfter.tasks.some((item) => item.title === "Слишком часто"), "повтор каждые пять минут не загружен");
  const { rows: [decision] } = await admin.query("SELECT options FROM eva_decisions WHERE user_id = $1", [bobId]);
  assert(JSON.stringify(decision.options) === JSON.stringify(["да", "нет, осенью\nесли не успею"]),
    "вариант решения с переводом строки вернулся одним пунктом");
  const longEntry = bobAfter.journal_entries.find((item) => item.content.startsWith("Длинный день"));
  assert(longEntry && longEntry.content.length === aliceBefore.journal_entries.find((item) => item.content.startsWith("Длинный день")).content.length,
    "запись дневника длиннее ячейки Excel вернулась целиком");
  assert(tasks["Повтор без расписания"] && tasks["Повтор без расписания"].next_run_at === null,
    "«повторять» без расписания загружено разовой задачей без срока");
  assert(bobAfter.eva_notes.some((item) => item.title === "Секрет Боба"), "своя заметка Боба на месте");

  // ---- час перевода часов: 01:30 бывает дважды -------------------------
  const { rows: [carol] } = await admin.query(
    `INSERT INTO users (telegram_id, first_name, timezone, timezone_source) VALUES ($1, 'Кэрол', 'America/New_York', 'iana') RETURNING id`,
    [CAROL]);
  // 06:30Z 1 ноября 2026 — второе 01:30 по Нью-Йорку (после перевода).
  await admin.query(
    `INSERT INTO tasks (user_id, title, remind_at, next_run_at, timezone)
     VALUES ($1, 'Ночной звонок', '2026-11-01T06:30:00Z', '2026-11-01T06:30:00Z', 'America/New_York')`, [carol.id]);
  sent.length = 0;
  await service().export(CAROL);
  const carolArchive = sent[0].bytes;
  const carolAgain = await service().apply(CAROL, carolArchive, createHash("sha256").update(carolArchive).digest("hex"));
  assert(carolAgain.added_total === 0, `задача в повторяющемся часе не задвоилась (${carolAgain.added_total})`);

  // ---- пояс «UTC» из файла тому, у кого он по умолчанию, — не заполнение ---
  const { rows: [dave] } = await admin.query(
    "INSERT INTO users (telegram_id, first_name, city) VALUES ($1, 'Дэйв', 'Лондон') RETURNING id", [DAVE]);
  sent.length = 0;
  await service().export(DAVE);
  const daveArchive = sent[0].bytes;
  const daveBefore = await snapshot(dave.id);
  const daveAgain = await service().apply(DAVE, daveArchive, createHash("sha256").update(daveArchive).digest("hex"));
  const { rows: [daveUser] } = await admin.query("SELECT timezone, timezone_source FROM users WHERE id = $1", [dave.id]);
  assert(daveAgain.added_total === 0 && daveAgain.filled_total === 0 && daveUser.timezone_source === null,
    `свой архив с поясом UTC ничего не «дополнил» (${daveAgain.filled_total}, ${daveUser.timezone_source})`);
  assert(JSON.stringify(await snapshot(dave.id)) === JSON.stringify(daveBefore), "строка пользователя не переписана");

  // ---- повтор той же загрузки ---------------------------------------
  const repeat = await service().apply(BOB, archive, mark);
  assert(repeat.added_total === 0, "повторная загрузка Бобу ничего не добавила");
  assert(JSON.stringify(await snapshot(bobId)) === JSON.stringify(bobAfter), "повторная загрузка ничего не изменила");
  assert(JSON.stringify(await snapshot(aliceId)) === JSON.stringify(aliceBefore), "данные Алисы не тронуты загрузкой Боба");

  const { rows: audit } = await admin.query(
    `SELECT operation, params_redacted_json FROM audit_log
      WHERE target = 'user_data_archive' AND at > now() - interval '5 minutes' ORDER BY at`);
  assert(audit.some((row) => row.operation === "archive.export") && audit.some((row) => row.operation === "archive.import"),
    "выгрузка и загрузка записаны в аудит");
  assert(!JSON.stringify(audit).includes("марафон"), "в аудите нет содержания");
  console.log("архив данных: выгрузка и дополняющая загрузка проверены на PostgreSQL");
} finally {
  await cleanup();
  await db.close();
  await admin.end();
}
