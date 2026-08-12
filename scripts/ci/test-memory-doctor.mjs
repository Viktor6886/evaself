/**
 * Проверки Memory Doctor прогоняются на НАСТОЯЩЕЙ базе.
 *
 * «ГОТОВО, КОГДА» шага 17 требует воспроизводимого и проверяемого
 * отчёта: на подготовленном наборе с известными дефектами найдены все
 * внесённые проблемы и не выдуманы отсутствующие. Поддельная база в
 * тестах сервиса этого не докажет — она не считает `similarity()`, не
 * знает пересечения периодов действительности и не выполняет
 * `NOT EXISTS` по чужой таблице.
 *
 * Скрипт заводит двух собственных пользователей: одному вносятся
 * дефекты, второй остаётся чистым. Чистый нужен ровно затем, чтобы
 * ложные срабатывания было видно, а не подразумевалось. За собой
 * скрипт убирает.
 */

import { createHash } from "node:crypto";

import pg from "../../eva-agent-service/node_modules/pg/lib/index.js";
import { MemoryDoctorService } from "../../eva-agent-service/dist/memory/doctor/service.js";

const { Client } = pg;

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

/** Область арендатора в этом скрипте не подменяется — она просто не мешает. */
const db = {
  query: (text, values) => client.query(text, values),
  transaction: async (work) => await work(db),
  withUserScope: async (_scope, work) => await work(),
  bindScopeUserId: () => {},
};

const memory = {
  enabled: true,
  versions: { recordFact: async () => { throw new Error("диагностика не пишет память"); } },
  entities: {
    merge: async () => { throw new Error("диагностика не объединяет сама"); },
    rollbackMerge: async () => false,
  },
  queries: {}, dedup: {}, backfill: {},
};

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function seedUser(telegramId) {
  const { rows } = await client.query(
    `INSERT INTO users (telegram_id, username, first_name, state)
     VALUES ($1, 'ci_doctor', 'CI', 'active')
     ON CONFLICT (telegram_id) DO UPDATE SET state = 'active'
     RETURNING id`,
    [telegramId],
  );
  return Number(rows[0].id);
}

async function node(userId, overrides) {
  const {
    nodeType = "person", key, title, status = "active", confidence = 0.9,
    sensitivity = "normal", contentJson = {}, sourceType = "conversation",
  } = overrides;
  const { rows } = await client.query(
    `INSERT INTO memory_nodes (
       user_id, node_type, canonical_key, title, text_content, content_json,
       status, confidence, sensitivity, source_type, valid_from
     ) VALUES ($1,$2,$3,$4,$4,$5::jsonb,$6,$7,$8,$9, now())
     ON CONFLICT (user_id, node_type, canonical_key) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [userId, nodeType, key, title, JSON.stringify(contentJson), status, confidence, sensitivity, sourceType],
  );
  return Number(rows[0].id);
}

async function evidenceFor(userId, nodeId, tag) {
  // Отпечаток обязан быть настоящим sha256: схема шага 15 проверяет его
  // формат, и «понятная» метка вместо хэша роняет вставку.
  const hash = createHash("sha256").update(`${userId}:${nodeId}:${tag}`).digest("hex");
  await client.query(
    `INSERT INTO memory_evidence (
       user_id, subject_kind, node_id, source_type, source_id, support, confidence, content_hash
     ) VALUES ($1, 'node', $2, 'conversation', $3, 'supports', 0.9, $4)
     ON CONFLICT DO NOTHING`,
    [userId, nodeId, tag, hash],
  );
}

async function version(userId, nodeId, overrides) {
  const {
    factKey, version: number = 1, status = "active", validFrom, validTo = null,
    observedAt = "now()",
  } = overrides;
  await client.query(
    `INSERT INTO memory_node_versions (
       user_id, node_id, fact_key, version, title, status, confidence,
       valid_from, valid_to, observed_at, change_reason, actor_type
     ) VALUES ($1,$2,$3,$4,'ci',$5,0.9,$6,$7,${observedAt},'ci','system')`,
    [userId, nodeId, factKey, number, status, validFrom, validTo],
  );
}

async function cleanup(userIds) {
  for (const userId of userIds) {
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
}

async function main() {
  await client.connect();
  const dirty = await seedUser(-90000101);
  const clean = await seedUser(-90000102);

  try {
    // ---- дефекты, внесённые намеренно -------------------------------
    // 1. Точный дубликат: одинаковый заголовок, разные ключи.
    const keepId = await node(dirty, { key: "ci:sister:1", title: "Сестра Аня" });
    await node(dirty, { key: "ci:sister:2", title: "Сестра Аня" });
    await evidenceFor(dirty, keepId, "ci-dup-1");
    // 2. Похожий, но не одинаковый заголовок — триграммное сходство.
    const similarId = await node(dirty, { key: "ci:trip:1", title: "Поездка в Прагу летом" });
    const similarOther = await node(dirty, { key: "ci:trip:2", title: "Поездка в Прагу летомъ" });
    await evidenceFor(dirty, similarId, "ci-sim-1");
    await evidenceFor(dirty, similarOther, "ci-sim-2");
    // 3. Низкая уверенность.
    const lowId = await node(dirty, { key: "ci:low:1", title: "Догадка", confidence: 0.2 });
    await evidenceFor(dirty, lowId, "ci-low-1");
    // 4. Чувствительный вывод под пометкой normal.
    const privacyId = await node(dirty, {
      nodeType: "psychological_feature", key: "ci:psy:1", title: "Гипотеза", sourceType: "curator",
    });
    await evidenceFor(dirty, privacyId, "ci-psy-1");
    // 5. Факт без единого доказательства.
    await node(dirty, { key: "ci:noevidence:1", title: "Без источника" });
    // 6. Две живые версии одного факта с пересекающимися периодами.
    await version(dirty, keepId, {
      factKey: "ci:overlap", version: 1, validFrom: "2020-01-01T00:00:00Z", validTo: null,
    });
    await version(dirty, keepId, {
      factKey: "ci:overlap", version: 2, validFrom: "2021-01-01T00:00:00Z", validTo: null,
    });
    // 7. Устаревший факт: наблюдался больше года назад.
    await version(dirty, similarId, {
      factKey: "ci:stale", version: 1, validFrom: "2015-01-01T00:00:00Z",
      observedAt: "now() - interval '400 days'",
    });
    // 8. Неразрешённое противоречие.
    await client.query(
      `INSERT INTO memory_conflicts (user_id, fact_key, node_id, kind, significance, status)
       VALUES ($1, 'ci:overlap', $2, 'contradiction', 'high', 'open')`,
      [dirty, keepId],
    );
    // 9. Потерянная связь графа: цель ссылается на снятый узел.
    const archived = await node(dirty, { key: "ci:archived:1", title: "Снятый", status: "archived" });
    await client.query(
      `INSERT INTO memory_edges (user_id, from_node_id, relation_type, to_node_id, confidence, status, source_type)
       VALUES ($1, $2, 'involves', $3, 0.9, 'active', 'ci')
       ON CONFLICT DO NOTHING`,
      [dirty, keepId, archived],
    );
    // 10. Неактуальная цель: срок прошёл.
    await client.query(
      `INSERT INTO goals (user_id, title, status, target_date, user_confirmed)
       VALUES ($1, 'CI-цель', 'active', current_date - 30, true)`,
      [dirty],
    );
    // 11 и 12. Расхождение с Letta и раздутая проекция блока.
    await client.query(
      `INSERT INTO letta_memory_block_sync (user_id, agent_id, label, desired_value, status, updated_at)
       VALUES ($1, 'ci-agent', 'current_state', $2, 'failed', now() - interval '2 hours')
       ON CONFLICT (agent_id, label) DO UPDATE SET status = 'failed'`,
      [dirty, "x".repeat(3_000)],
    );

    // ---- чистый пользователь: те же виды записей, но без дефектов ----
    const cleanNode = await node(clean, { key: "ci:clean:1", title: "Брат Пётр" });
    await evidenceFor(clean, cleanNode, "ci-clean-1");
    await version(clean, cleanNode, {
      factKey: "ci:clean", version: 1, validFrom: "2024-01-01T00:00:00Z", validTo: null,
    });

    const doctor = new MemoryDoctorService(db, memory, logger, true);

    const report = await doctor.run({ userId: dirty, reportKey: `ci-${Date.now()}`, trigger: "admin" });
    const byCheck = new Map(report.sections.map((section) => [section.check, section]));
    const expected = [
      "duplicate_nodes", "semantic_duplicates", "contradictions", "stale_facts",
      "wrong_version_for_time", "low_confidence", "missing_evidence", "stale_goals",
      "oversized_core_memory", "privacy_mismatch", "lost_graph_links", "letta_divergence",
    ];
    for (const check of expected) {
      const section = byCheck.get(check);
      assert(section?.status === "checked", `проверка ${check} выполнена (${section?.status})`);
      assert(section.findings > 0, `проверка ${check} нашла внесённый дефект`);
    }
    // Единственная проверка, чья таблица появится шагом 18.
    assert(
      byCheck.get("orphan_embeddings")?.status === "not_applicable",
      "orphan_embeddings без таблицы embeddings объявлена неприменимой",
    );
    assert(report.reportId !== null, "отчёт сохранён");

    // Каждая находка ссылается на конкретные записи.
    assert(
      report.findings.every((finding) => finding.subject.ids.length > 0),
      "каждая находка называет конкретные записи",
    );

    // Повторный прогон того же ключа не удваивает отчёт.
    const same = await doctor.run({ userId: dirty, reportKey: report.reportKey, trigger: "admin" });
    assert(same.reportId === null, "повторный прогон того же ключа не создаёт второго отчёта");

    // Отчёт воспроизводим: те же данные — тот же набор находок.
    const again = await doctor.run({ userId: dirty, reportKey: `ci-${Date.now()}-2`, trigger: "admin" });
    assert(
      JSON.stringify(again.findings.map((item) => item.id).sort())
        === JSON.stringify(report.findings.map((item) => item.id).sort()),
      "повторный прогон на тех же данных даёт тот же набор находок",
    );

    // Ложных срабатываний на чистом пользователе нет.
    const cleanReport = await doctor.run({ userId: clean, reportKey: `ci-clean-${Date.now()}`, trigger: "admin" });
    assert(
      cleanReport.findings.length === 0,
      `на чистом наборе находок нет (получено ${cleanReport.findings.length}: `
        + `${cleanReport.findings.map((item) => item.check).join(", ")})`,
    );

    // Диагностика ничего не записала: любая попытка записи в память
    // здесь выбрасывает исключение, и прогон бы упал.
    const { rows: proposals } = await client.query(
      `SELECT count(*)::int AS count FROM memory_doctor_actions WHERE user_id = $1 AND status = 'applied'`,
      [dirty],
    );
    assert(proposals[0].count === 0, "ни одно предложение не применено автоматически");

    console.log("Memory Doctor: диагностика на настоящей базе проверена");
  } finally {
    await cleanup([dirty, clean]);
    await client.end();
  }
}

await main();
