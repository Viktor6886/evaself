/**
 * Гибридный поиск на НАСТОЯЩЕЙ базе.
 *
 * Главное, что здесь проверяется, — нулевая утечка между пользователями.
 * Поддельная база в тестах сервиса доказать этого не может: она не
 * выполняет ни `<=>` из pgvector, ни рекурсивный обход графа, а
 * забытый предикат владельца даёт зелёные тесты и чужую память в
 * ответе. Заодно проверяются «сейчас» и «на дату», удаление дубликатов
 * фрагментов и безопасная деградация по таймауту.
 */

import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { HybridRetrieval } from "../../eva-agent-service/dist/memory/retrieval/hybrid.js";
import { MemoryEmbeddings } from "../../eva-agent-service/dist/memory/retrieval/embeddings.js";

const { Client } = pg;
const DIMENSION = 8;
const MODEL = "ci-embedding";

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

const db = {
  query: (text, values) => client.query(text, values),
  transaction: async (work) => await work(db),
  withUserScope: async (_scope, work) => await work(),
  bindScopeUserId: () => {},
};

/** Вектор считается детерминированно: сеть в CI не нужна. */
function fakeVector(seed) {
  return Array.from({ length: DIMENSION }, (_, index) => Math.sin(seed + index) / 2 + 0.5);
}

const embeddingClient = {
  model: MODEL,
  dimension: DIMENSION,
  embed: async (texts) => texts.map((text) => fakeVector(text.length)),
};

async function seedUser(telegramId) {
  const { rows } = await client.query(
    `INSERT INTO users (telegram_id, username, first_name, state)
     VALUES ($1, 'ci_retrieval', 'CI', 'active')
     ON CONFLICT (telegram_id) DO UPDATE SET state = 'active'
     RETURNING id`,
    [telegramId],
  );
  return Number(rows[0].id);
}

async function node(userId, key, title, text, validFrom = "2020-01-01") {
  const { rows } = await client.query(
    `INSERT INTO memory_nodes (
       user_id, node_type, canonical_key, title, text_content, status,
       confidence, sensitivity, source_type, valid_from
     ) VALUES ($1, 'person', $2, $3, $4, 'active', 0.9, 'normal', 'conversation', $5)
     ON CONFLICT (user_id, node_type, canonical_key) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [userId, key, title, text, validFrom],
  );
  return Number(rows[0].id);
}

async function main() {
  await client.connect();
  const mine = await seedUser(-90000201);
  const stranger = await seedUser(-90000202);

  try {
    const secret = "Прага командировка секрет";
    const mineNode = await node(mine, "ci:mine", "Прага моя", "поездка в Прагу");
    const strangerNode = await node(stranger, "ci:stranger", "Прага чужая", secret);
    // Факт, действовавший только до 2022 года: он обязан находиться «на
    // дату» и не находиться «сейчас».
    await client.query(
      `UPDATE memory_nodes SET valid_from = '2019-01-01', valid_to = '2022-01-01', status = 'superseded'
        WHERE user_id = $1 AND id = $2`,
      [mine, await node(mine, "ci:past", "Прага прежняя", "старый факт", "2019-01-01")],
    );

    const embeddings = new MemoryEmbeddings(db, embeddingClient, 1);
    await embeddings.index(mine, [{ kind: "node", id: mineNode, text: "поездка в Прагу" }]);
    await embeddings.index(stranger, [{ kind: "node", id: strangerNode, text: secret }]);

    const retrieval = new HybridRetrieval(db, {
      enabled: true, model: MODEL, embeddingVersion: 1,
    });
    const vector = fakeVector(secret.length);

    // 1. Нулевая утечка: вектор запроса совпадает с ЧУЖИМ фрагментом.
    const result = await retrieval.search({ userId: mine, text: "Прага", vector, limit: 20 });
    const ids = result.candidates.map((candidate) => candidate.nodeId);
    assert(!ids.includes(strangerNode), "чужой узел не попал в выборку по вектору");
    assert(
      !JSON.stringify(result.candidates).includes(secret),
      "чужой текст не попал в ответ ни одним источником",
    );
    assert(ids.includes(mineNode), "свой узел найден");

    // 2. Дубликаты фрагментов: один узел — один кандидат, хотя его нашли
    //    и полнотекстовый поиск, и триграммы, и вектор.
    assert(
      new Set(ids).size === ids.length,
      "один узел встречается в выборке один раз",
    );
    const merged = result.candidates.find((candidate) => candidate.nodeId === mineNode);
    assert(merged.sources.length >= 2, `узел найден несколькими источниками (${merged.sources})`);

    // 3. «Сейчас» и «на дату» отвечают по-разному.
    const now = await retrieval.search({ userId: mine, text: "Прага", limit: 20 });
    const past = await retrieval.search({
      userId: mine, text: "Прага", limit: 20, asOf: new Date("2021-06-01T00:00:00Z"),
    });
    const nowTitles = now.candidates.map((candidate) => candidate.title);
    const pastTitles = past.candidates.map((candidate) => candidate.title);
    assert(!nowTitles.includes("Прага прежняя"), "снятый факт не в текущем снимке");
    assert(pastTitles.includes("Прага прежняя"), "снятый факт находится на свою дату");

    // 4. Таймаут — безопасная деградация, а не отказ ответа.
    const degrading = new HybridRetrieval(db, {
      enabled: true, model: MODEL, embeddingVersion: 1, timeoutMs: 0,
    });
    const degraded = await degrading.search({ userId: mine, text: "Прага", vector });
    assert(degraded.degraded === true, "исчерпанный бюджет объявлен деградацией");
    assert(Array.isArray(degraded.candidates), "деградация возвращает выборку, а не исключение");

    // 5. Осиротевший вектор убирается вместе с фактом.
    await embeddings.forget(mine, "node", mineNode);
    const { rows: left } = await client.query(
      `SELECT count(*)::int AS count FROM memory_embeddings WHERE user_id = $1 AND subject_id = $2`,
      [mine, mineNode],
    );
    assert(left[0].count === 0, "вектор удалён вместе с предметом");

    console.log("Гибридный поиск: изоляция, время и деградация проверены");
  } finally {
    for (const userId of [mine, stranger]) {
      await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    await client.end();
  }
}

await main();
