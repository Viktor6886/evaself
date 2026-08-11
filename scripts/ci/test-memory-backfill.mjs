/**
 * Перенос памяти на temporal-путь выполняется на НАСТОЯЩЕЙ базе.
 *
 * Юнит-тесты шага 15 проверяют перенос на поддельной базе: она повторяет
 * правила выборки, но не уникальные индексы, не `ON CONFLICT DO NOTHING`
 * и не внешние ключи. А идемпотентность переноса держится именно на них:
 * повторная начальная версия отбрасывается индексом
 * `memory_node_versions_node_version_uidx`, повторное доказательство —
 * частичным индексом `memory_evidence_node_dedup_uidx`. Проверить это
 * без PostgreSQL нельзя, а «ГОТОВО, КОГДА» шага требует именно
 * выполненного и проверенного переноса.
 *
 * Скрипт создаёт собственных пользователей, переносит их узлы, повторяет
 * перенос и убирает за собой. Соседние строки в базе он не трогает.
 */

// Путь явный: скрипт лежит вне пакета сервиса, и разрешение голого
// имени пошло бы мимо его node_modules — так же, как в
// `test-distributed-limits.mjs`.
import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { TemporalBackfill } from "../../eva-agent-service/dist/memory/temporal/backfill.js";

const { Client } = pg;

const BACKFILL_KEY = "ci_memory_backfill";
const MARK = "ci-backfill";

function assert(condition, message) {
  if (!condition) {
    console.error(`::error::${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`  ✔ ${message}`);
}

const client = new Client({
  host: process.env.PGHOST ?? "localhost",
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE ?? "eva",
  port: Number(process.env.PGPORT ?? 5432),
});

const queryable = { query: (text, values) => client.query(text, values) };

async function seedUsers() {
  const ids = [];
  for (const telegramId of [-90000001, -90000002]) {
    const { rows } = await client.query(
      `INSERT INTO users (telegram_id, first_name)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name
       RETURNING id`,
      [telegramId, MARK],
    );
    ids.push(Number(rows[0].id));
  }
  return ids;
}

async function seedLegacyNodes(userIds) {
  // Узлы «как до шага 15»: без fact_key, без версии, без доказательств —
  // ровно то состояние, в котором их застаёт перенос.
  let created = 0;
  for (const userId of userIds) {
    for (let index = 0; index < 3; index += 1) {
      await client.query(
        `INSERT INTO memory_nodes (
           user_id, node_type, canonical_key, title, text_content, content_json,
           status, confidence, sensitivity, source_type, source_id, created_at
         ) VALUES ($1, 'interest', $2, $3, $4, '{}'::jsonb,
                   'active', 0.9, 'normal', 'profile', $5, now() - interval '30 days')
         ON CONFLICT (user_id, node_type, canonical_key) DO NOTHING`,
        [
          userId,
          `${MARK}:${userId}:${index}`,
          `Интерес ${index}`,
          `Описание интереса ${index}`,
          `field-${index}`,
        ],
      );
      created += 1;
    }
  }
  return created;
}

async function counts(userIds) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM memory_nodes WHERE user_id = ANY($1::bigint[])) AS nodes,
       (SELECT count(*) FROM memory_node_versions WHERE user_id = ANY($1::bigint[])) AS versions,
       (SELECT count(*) FROM memory_evidence WHERE user_id = ANY($1::bigint[])) AS evidence,
       (SELECT count(*) FROM memory_nodes
         WHERE user_id = ANY($1::bigint[])
           AND (fact_key IS NULL OR current_version_id IS NULL)) AS unmigrated`,
    [userIds],
  );
  return {
    nodes: Number(rows[0].nodes),
    versions: Number(rows[0].versions),
    evidence: Number(rows[0].evidence),
    unmigrated: Number(rows[0].unmigrated),
  };
}

async function cleanup(userIds) {
  await client.query(`DELETE FROM memory_backfill_state WHERE backfill_key = $1`, [BACKFILL_KEY]);
  // Users каскадом уносят узлы, версии, доказательства и всё остальное.
  await client.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [userIds]);
}

async function main() {
  await client.connect();
  let userIds = [];
  try {
    userIds = await seedUsers();
    // Узлы прошлого прогона на том же стенде снимаются, а не переносятся:
    // иначе счётчики сравнивались бы с чужим остатком.
    await client.query(`DELETE FROM memory_nodes WHERE user_id = ANY($1::bigint[])`, [userIds]);
    const seeded = await seedLegacyNodes(userIds);
    console.log(`посеяно ${seeded} узлов у ${userIds.length} пользователей`);

    const backfill = new TemporalBackfill();

    // Партиями по два: перенос обязан переживать обрыв между партиями.
    const first = await backfill.runToCompletion(queryable, {
      key: BACKFILL_KEY,
      batchSize: 2,
    });
    assert(first.done === true, "перенос дошёл до конца");

    const after = await counts(userIds);
    assert(after.unmigrated === 0, "у каждого узла появились fact_key и текущая версия");
    assert(after.versions === after.nodes, "ровно одна начальная версия на узел");
    assert(after.evidence === after.nodes, "источник узла стал его первым доказательством");

    // Владелец версии обязан совпасть с владельцем узла: перенос идёт по
    // всем арендаторам сразу, и перепутанный user_id здесь означал бы
    // утечку памяти одного человека другому.
    const { rows: mismatched } = await client.query(
      `SELECT count(*) AS bad
         FROM memory_node_versions v
         JOIN memory_nodes n ON n.id = v.node_id
        WHERE n.user_id = ANY($1::bigint[]) AND v.user_id <> n.user_id`,
      [userIds],
    );
    assert(Number(mismatched[0].bad) === 0, "владелец версии совпадает с владельцем узла");

    // Повтор с нуля: курсор сброшен, данные те же. Идемпотентность
    // держится на индексах, а не на курсоре.
    await client.query(`DELETE FROM memory_backfill_state WHERE backfill_key = $1`, [BACKFILL_KEY]);
    const second = await backfill.runToCompletion(queryable, {
      key: BACKFILL_KEY,
      batchSize: 10,
    });
    assert(second.migrated === 0, "повторный перенос не создал ни одной новой версии");

    const repeated = await counts(userIds);
    assert(repeated.versions === after.versions, "число версий после повтора не изменилось");
    assert(
      repeated.evidence === after.evidence,
      "повторный перенос не добавил независимых доказательств",
    );

    console.log("перенос temporal-памяти выполнен и проверен на настоящей базе");
  } finally {
    if (userIds.length > 0) await cleanup(userIds);
    await client.end();
  }
}

await main();
