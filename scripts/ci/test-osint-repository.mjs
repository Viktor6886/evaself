/**
 * OSINT-хранилище на НАСТОЯЩЕЙ базе.
 *
 * Поддельное хранилище в тестах сервиса повторяет правила, но не
 * исполняет SQL: `ON CONFLICT` по частичному индексу прогонов, `SKIP
 * LOCKED` очереди, каскады удаления и внешние ключи по паре
 * (id, user_id). На них держатся требования batch OSINT-3:
 *
 *   • повтор создания с тем же ключом возвращает то же исследование;
 *   • дневной лимит не пропускает лишнее исследование;
 *   • повтор задания после сбоя не запускает завершённый прогон второй
 *     раз и не дублирует источники и доказательства;
 *   • чужое исследование нельзя ни прочитать, ни взять в работу;
 *   • удаление уносит граф исследования и осиротевшие сущности, но не
 *     трогает сущности, нужные другому исследованию;
 *   • политика хранения удаляет только завершённые исследования.
 *
 * Скрипт заводит собственных пользователей и убирает за собой.
 */

import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { OsintService } from "../../eva-agent-service/dist/osint/service.js";
import { PgOsintStore } from "../../eva-agent-service/dist/osint/repository.js";
import { OsintOrchestrator } from "../../eva-agent-service/dist/osint/orchestrator.js";
import { structuredEvidence } from "../../eva-agent-service/dist/osint/evidence.js";
import { RETENTION_QUERIES } from "../../eva-agent-service/dist/retention/service.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Граница арендатора живёт в `Database`; здесь проверяется семантика
// схемы, а владелец в каждом запросе хранилища задан явно.
const db = {
  query: (sql, values) => pool.query(sql, values),
  withUserScope: async (_scope, work) => await work(),
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

async function rejects(promise, code, message) {
  try {
    await promise;
  } catch (error) {
    assert(error.code === code, `${message} (${error.code})`);
    return;
  }
  assert(false, message);
}

const TELEGRAM_IDS = [-90530001, -90530002];
const user = async (telegramId) => Number((await pool.query(
  `INSERT INTO users(telegram_id, first_name, timezone)
   VALUES ($1, 'OSINT CI', 'UTC')
   ON CONFLICT(telegram_id) DO UPDATE SET first_name = EXCLUDED.first_name
   RETURNING id`,
  [telegramId],
)).rows[0].id);

const jobs = [];
const outbox = { record: async (_client, intent) => { jobs.push(intent); return { inserted: true }; } };
const count = async (sql, values) => Number((await pool.query(sql, values)).rows[0].count);

function profileCollector(calls) {
  return {
    name: "maigret",
    accepts: (type) => type === "username",
    reserve: (remaining) => Math.min(remaining, 12),
    collect: async ({ target }) => {
      calls.push(target.normalized);
      const url = `https://site.example/${target.normalized}`;
      const evidence = structuredEvidence({ url });
      return {
        status: "succeeded",
        externalRequests: 12,
        sources: [{
          locator: url, canonicalUrl: url, domain: "site.example", tier: "official_profile",
          retrievedAt: new Date().toISOString(), contentHash: evidence.hash,
          findings: [
            {
              kind: "account", evidence, site: "Site", url,
              confirmedBy: ["maigret", "whatsmyname"], contradictedBy: [], unverifiedBy: [],
              properties: [{ property: "name", value: "CI Person" }],
            },
            ...(target.depth === 0 ? [{
              kind: "discovered", evidence, owner: url,
              identifier: { type: "username", raw: `${target.normalized}_two`, normalized: `${target.normalized}_two` },
            }] : []),
          ],
        }],
      };
    },
  };
}

const input = (userId, key, extra = {}) => ({
  userId,
  query: "CI: проверка контура",
  purpose: "Проверка работы хранилища в CI",
  subject: "person",
  seeds: [{ type: "username", value: "ci_osint_user" }, { type: "email", value: "ci@example.com" }],
  idempotencyKey: key,
  ...extra,
});

try {
  const [first, second] = [await user(TELEGRAM_IDS[0]), await user(TELEGRAM_IDS[1])];
  await pool.query(`DELETE FROM osint_investigations WHERE user_id = ANY($1)`, [[first, second]]);
  const service = new OsintService(db, outbox, null, { enabled: true, dailyLimit: 2 });

  // ------------------------------------------------------------------
  // Создание: идемпотентность, субъект, очередь, лимит
  // ------------------------------------------------------------------
  const created = await service.create(input(first, "ci-osint-key-0001"));
  const again = await service.create(input(first, "ci-osint-key-0001"));
  assert(created.created && !again.created && again.id === created.id, "повтор с тем же ключом возвращает то же исследование");
  assert(jobs.length === 1 && jobs[0].payloadRef === created.id && !("query" in jobs[0].payload), "задание несёт id, а не текст запроса");
  assert(await count(`SELECT count(*) FROM osint_frontier WHERE investigation_id = $1 AND user_id = $2 AND depth = 0`, [created.id, first]) === 2,
    "идентификаторы запроса стоят в очереди на глубине 0");
  const subject = (await pool.query(`SELECT subject_entity_id FROM osint_investigations WHERE id = $1 AND user_id = $2`, [created.id, first])).rows[0].subject_entity_id;
  assert(Boolean(subject), "у исследования есть субъект");
  assert(await count(`SELECT count(*) FROM audit_log WHERE target = $1 AND operation = 'osint.investigation.create'
                        AND NOT params_redacted_json::text LIKE '%ci_osint_user%'`, [created.id]) === 1,
    "создание записано в аудит без значений идентификаторов");

  // Два одновременных запроса с одним ключом получают одно исследование,
  // а не отказ по лимиту или по уникальному ключу.
  const [left, right] = await Promise.all([
    service.create(input(first, "ci-osint-key-0002")),
    service.create(input(first, "ci-osint-key-0002")),
  ]);
  assert(left.id === right.id && left.created !== right.created, "одновременные запросы с одним ключом дают одно исследование");
  await rejects(service.create(input(first, "ci-osint-key-0003")), "osint_daily_limit", "дневной лимит не пропускает третье исследование");

  // ------------------------------------------------------------------
  // Чужое исследование недоступно
  // ------------------------------------------------------------------
  assert(await service.status(second, created.id) === null, "второй пользователь не видит чужое исследование");
  assert(await new PgOsintStore(db, second, created.id).begin() === null, "второй пользователь не может взять чужое исследование в работу");
  assert(!(await service.cancel(second, created.id)), "второй пользователь не может отменить чужое исследование");
  assert(!(await service.delete(second, created.id)), "второй пользователь не может удалить чужое исследование");

  // ------------------------------------------------------------------
  // Прогон, обрыв и повтор
  // ------------------------------------------------------------------
  const calls = [];
  const store = new PgOsintStore(db, first, created.id);
  const controller = new AbortController();
  const aborting = {
    name: "web_search",
    accepts: (type) => type === "email",
    reserve: () => 1,
    collect: async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  };
  let aborted = false;
  try {
    await new OsintOrchestrator(store, [profileCollector(calls), aborting]).run(controller.signal);
  } catch {
    aborted = true;
  }
  assert(aborted, "первый заход оборван посреди работы");

  const quiet = { name: "web_search", accepts: (type) => type === "email", reserve: () => 1, collect: async () => ({ status: "succeeded", externalRequests: 1, sources: [] }) };
  const summary = await new OsintOrchestrator(store, [profileCollector(calls), quiet]).run(new AbortController().signal);
  assert(summary.status === "completed", "второй заход завершает исследование");
  assert(calls.filter((name) => name === "ci_osint_user").length === 1, "завершённый прогон по той же цели не повторяется");
  assert(calls.includes("ci_osint_user_two"), "найденный username обработан на следующей глубине");
  // Порядок элементов одной глубины не задан, поэтому считается итог:
  // по источнику на каждый из двух профилей, без дублей.
  assert(await count(`SELECT count(*) FROM osint_sources WHERE investigation_id = $1 AND user_id = $2 AND collector <> 'seed'`, [created.id, first]) === 2,
    "источники не продублированы повтором");
  assert(await count(`SELECT count(*) FROM osint_entity_matches WHERE investigation_id = $1 AND user_id = $2 AND status IN ('confirmed','probable')`, [created.id, first]) === 0,
    "совпадение ника не объявлено тождеством");
  const status = await service.status(first, created.id);
  assert(status.status === "completed" && status.externalRequests === 25, "статус и счётчик запросов сходятся");
  assert(await count(`SELECT count(*) FROM audit_log WHERE target = $1 AND operation = 'osint.investigation.view'`, [created.id]) >= 1,
    "просмотр статуса записан в аудит");

  // Сущность, найденная в двух исследованиях, — одна строка.
  const second_ = (await pool.query(`SELECT id FROM osint_investigations WHERE user_id = $1 AND idempotency_key = 'ci-osint-key-0002'`, [first])).rows[0].id;
  await new OsintOrchestrator(new PgOsintStore(db, first, second_), [profileCollector([]), quiet]).run(new AbortController().signal);
  assert(await count(`SELECT count(*) FROM osint_entities WHERE user_id = $1 AND schema = 'UserAccount' AND caption = 'https://site.example/ci_osint_user'`, [first]) === 1,
    "один профиль у одного пользователя — одна сущность");

  // ------------------------------------------------------------------
  // Удаление и хранение
  // ------------------------------------------------------------------
  assert(await service.delete(first, created.id), "владелец удаляет исследование");
  assert(await count(`SELECT count(*) FROM osint_sources WHERE investigation_id = $1`, [created.id]) === 0, "граф исследования удалён каскадом");
  assert(await count(`SELECT count(*) FROM osint_entities WHERE user_id = $1 AND caption = 'https://site.example/ci_osint_user'`, [first]) === 1,
    "сущность, нужная другому исследованию, осталась");
  assert(await count(`SELECT count(*) FROM osint_entities WHERE user_id = $1 AND caption = 'https://site.example/ci_osint_user_two'`, [first]) === 1,
    "профиль из второго исследования на месте");

  await pool.query(`UPDATE osint_investigations SET created_at = now() - interval '400 days' WHERE user_id = $1`, [first]);
  const running = await service.create(input(second, "ci-osint-key-0004"));
  await pool.query(`UPDATE osint_investigations SET created_at = now() - interval '400 days', status = 'processing' WHERE id = $1 AND user_id = $2`, [running.id, second]);
  await pool.query(`UPDATE osint_entities SET created_at = now() - interval '400 days' WHERE user_id = ANY($1)`, [[first, second]]);
  await pool.query(`UPDATE osint_identifiers SET first_seen = now() - interval '400 days' WHERE user_id = ANY($1)`, [[first, second]]);
  const eligible = async () => {
    let total = 0;
    for (const sql of RETENTION_QUERIES.osint_investigations.count) total += Number((await pool.query(sql, [90])).rows[0].value);
    return total;
  };
  assert(await eligible() > 0, "хранение видит старые исследования");
  for (const sql of RETENTION_QUERIES.osint_investigations.apply) await pool.query(sql, [90, 1000]);
  assert(await count(`SELECT count(*) FROM osint_investigations WHERE user_id = $1`, [first]) === 0, "хранение удаляет старые завершённые исследования");
  assert(await count(`SELECT count(*) FROM osint_entities WHERE user_id = $1`, [first]) === 0, "и осиротевшие сущности вместе с ними");
  assert(await count(`SELECT count(*) FROM osint_investigations WHERE id = $1`, [running.id]) === 1, "идущее исследование хранение не трогает");
  assert(await count(`SELECT count(*) FROM osint_entities WHERE user_id = $1`, [second]) > 0, "его сущности тоже остаются");
  // Осиротевшая сущность без единого исследования всё равно считается:
  // иначе остаток после прерванной очистки не удалился бы никогда.
  const orphanId = (await pool.query(
    `INSERT INTO osint_entities (id, user_id, schema, caption, created_at)
     VALUES (gen_random_uuid(), $1, 'Person', 'orphan', now() - interval '400 days') RETURNING id`, [first])).rows[0].id;
  assert(await eligible() >= 1, "осиротевшая сущность попадает в подсчёт хранения");
  for (const sql of RETENTION_QUERIES.osint_investigations.apply) await pool.query(sql, [90, 1000]);
  assert(await count(`SELECT count(*) FROM osint_entities WHERE id = $1`, [orphanId]) === 0, "и удаляется следующим заходом");
} finally {
  await pool.query(`DELETE FROM osint_investigations WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ANY($1))`, [TELEGRAM_IDS]);
  await pool.query(`DELETE FROM osint_entities WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ANY($1))`, [TELEGRAM_IDS]);
  await pool.query(`DELETE FROM osint_identifiers WHERE user_id IN (SELECT id FROM users WHERE telegram_id = ANY($1))`, [TELEGRAM_IDS]);
  await pool.query(`DELETE FROM users WHERE telegram_id = ANY($1)`, [TELEGRAM_IDS]);
  await pool.end();
}
console.log("OSINT-хранилище на настоящей базе: ok");
