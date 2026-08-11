/**
 * Политики хранения: предпросмотр, удаление по классам, задержки и
 * граница между «удаляем» и «не обещаем».
 *
 * База подменена таблицами в памяти: проверяются правила применения
 * политики, а не SQL. Сам SQL проходит через CI на настоящей базе.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKUP_ROTATION_DAYS,
  RETENTION_CLASSES,
  effectivePolicies,
} from "../dist/retention/policy.js";
import { RETENTION_QUERIES, RetentionService } from "../dist/retention/service.js";
import { ALL_SETTINGS } from "../dist/admin/settings-registry.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Поддельная база: считает подпадающие строки и «удаляет» их пакетами.
 * `aged` — искусственно состаренные строки по классам.
 */
class FakeRetentionDatabase {
  aged: Record<string, number> = {};
  holds: string[] = [];
  runs: Record<string, unknown>[] = [];
  failHolds = false;
  batches = 0;
  /** Какие таблицы задело применение политики. */
  touched = new Set<string>();

  query = async (sql: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.includes("FROM retention_holds")) {
      if (this.failHolds) throw new Error("нет связи с базой");
      return { rows: this.holds.map((code) => ({ data_class: code })), rowCount: this.holds.length };
    }
    if (text.startsWith("INSERT INTO retention_runs")) {
      this.runs.push({
        data_class: values[0],
        dry_run: values[1],
        examined: values[2],
        affected: values[3],
        held: values[4],
        status: values[5],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith("SELECT 0::int AS value")) return { rows: [{ value: 0 }], rowCount: 1 };

    // Ключ считает и класс, и таблицу: политика «сырой payload
    // Telegram» обязана дойти и до входящих, и до исходящих, и общий
    // счётчик это скрыл бы.
    const table = text.includes("telegram_updates")
      ? "telegram_updates"
      : text.includes("telegram_outbox")
        ? "telegram_outbox"
        : text.includes("job_dead_letters")
          ? "job_dead_letters"
          : text.includes("job_mirror_samples")
            ? "job_mirror_samples"
            : null;
    const redacting = text.includes("payload <> ");
    const target = table === "telegram_updates"
      ? (redacting ? "telegram_payload" : "telegram_idempotency")
      : table === "telegram_outbox"
        ? (redacting ? "telegram_payload_outbox" : "telegram_idempotency_outbox")
        : table === "job_dead_letters"
          ? "dead_letters"
          : table === "job_mirror_samples"
            ? "metrics_aggregated"
            : null;
    if (table) this.touched.add(table);
    if (!target) throw new Error(`Неожиданный запрос: ${text.slice(0, 60)}`);

    if (text.startsWith("SELECT count(")) {
      return { rows: [{ value: this.aged[target] ?? 0 }], rowCount: 1 };
    }
    // Пакет удаления: забираем не больше размера пакета.
    this.batches += 1;
    const batchSize = Number(values[1]);
    const available = this.aged[target] ?? 0;
    const taken = Math.min(batchSize, available);
    this.aged[target] = available - taken;
    return { rows: [], rowCount: taken };
  };

  withSystemScope = async <T>(_reason: string, work: () => Promise<T>): Promise<T> => await work();
}

function build(options: { enabled?: boolean; batchSize?: number } = {}) {
  const db = new FakeRetentionDatabase();
  const service = new RetentionService(
    db as never,
    logger as never,
    options.enabled ?? false,
    { batchSize: options.batchSize ?? 100, maxBatches: 5 },
  );
  return { db, service };
}

// ---------------------------------------------------------------------
// Политики
// ---------------------------------------------------------------------

test("у каждого класса данных есть политика, и сроки лежат в границах", () => {
  const policies = effectivePolicies({});
  for (const item of RETENTION_CLASSES) {
    if (item.defaultDays === null) {
      // Каноническая память и документы пользователя: срока нет по
      // существу, и выдуманное число было бы обещанием удалить.
      assert.ok(!(item.code in policies), `${item.code} не должен иметь автоматического срока`);
      assert.equal(item.action, "manual");
      continue;
    }
    const days = policies[item.code]! / 86_400;
    assert.equal(days, item.defaultDays, item.code);
    assert.ok(days >= (item.minDays ?? 0) && days <= (item.maxDays ?? days), item.code);
  }
  // Значения из задания шага 10.
  assert.equal(policies.app_logs! / 86_400, 7);
  assert.equal(policies.telegram_payload! / 86_400, 7);
  assert.equal(policies.telegram_idempotency! / 86_400, 30);
  assert.equal(policies.dead_letters! / 86_400, 90);
  assert.ok(policies.metrics_aggregated! / 86_400 >= 365);
});

test("настройка сверх допустимых границ зажимается, а не принимается", () => {
  const stretched = effectivePolicies({
    "retention.app_logs_days": 3650,
    "retention.dead_letters_days": 1,
  });
  assert.equal(stretched.app_logs! / 86_400, 30, "максимум класса");
  assert.equal(stretched.dead_letters! / 86_400, 30, "минимум класса");
});

test("политики версионируются существующим Config Service, а не своей системой", () => {
  // Каждая настраиваемая политика обязана быть настройкой реестра: так
  // её изменение получает версию, аудит и откат без второй системы.
  for (const item of RETENTION_CLASSES) {
    if (!item.settingKey) continue;
    const definition = ALL_SETTINGS.find((setting) => setting.key === item.settingKey);
    assert.ok(definition, `${item.code}: настройка ${item.settingKey} не объявлена`);
    assert.equal(definition!.type, "integer");
    assert.equal(definition!.group, "retention");
    assert.equal(definition!.min, item.minDays);
    assert.equal(definition!.max, item.maxDays);
  }
});

// ---------------------------------------------------------------------
// Предпросмотр и удаление
// ---------------------------------------------------------------------

test("предпросмотр считает и ничего не удаляет", async () => {
  const { db, service } = build();
  db.aged = { telegram_payload: 250, dead_letters: 10 };

  const report = await service.preview();

  assert.equal(report.dryRun, true);
  assert.equal(db.batches, 0, "ни одного пакета удаления");
  assert.equal(db.aged.telegram_payload, 250, "данные на месте");
  const payload = report.classes.find((item) => item.code === "telegram_payload")!;
  assert.equal(payload.eligible, 250);
  assert.equal(payload.affected, 0);
  // Отчёт честно называет срок жизни удалённого в резервных копиях.
  assert.equal(report.backupRotationDays, BACKUP_ROTATION_DAYS);
  assert.ok(db.runs.every((row) => row.dry_run === true));
});

test("искусственно состаренные данные удаляются пакетами по классу", async () => {
  const { db, service } = build({ enabled: true, batchSize: 100 });
  db.aged = {
    telegram_payload: 250,
    telegram_payload_outbox: 40,
    dead_letters: 30,
    metrics_aggregated: 0,
  };

  const report = await service.enforce();

  assert.equal(report.dryRun, false);
  const payload = report.classes.find((item) => item.code === "telegram_payload")!;
  assert.equal(payload.affected, 290, "обработаны и входящие, и исходящие");
  assert.equal(db.aged.telegram_payload, 0);
  assert.equal(db.aged.telegram_payload_outbox, 0);
  assert.ok(
    db.touched.has("telegram_updates") && db.touched.has("telegram_outbox"),
    "класс заявлен для inbox и outbox — значит обязан дойти до обоих",
  );
  assert.equal(db.aged.dead_letters, 0);
  // Пакеты маленькие: 250 строк — это три захода по сто, а не один
  // запрос на четверть тысячи.
  assert.ok(db.batches >= 3);
});

test("выключенный флаг не удаляет ничего, даже если данные состарены", async () => {
  const { db, service } = build({ enabled: false });
  db.aged = { telegram_payload: 500 };

  const report = await service.enforce();

  assert.equal(report.dryRun, true, "выключенный флаг остаётся предпросмотром");
  assert.equal(db.aged.telegram_payload, 500);
  assert.equal(db.batches, 0);
});

test("каноническая память и документы пользователя не удаляются автоматически", async () => {
  const { db, service } = build({ enabled: true });
  db.aged = { telegram_payload: 10 };
  const report = await service.enforce();

  for (const code of ["canonical_memory", "user_documents"]) {
    const item = report.classes.find((entry) => entry.code === code)!;
    assert.equal(item.action, "manual");
    assert.equal(item.affected, 0);
    assert.equal(item.days, null);
    assert.match(item.note ?? "", /решению пользователя/);
  }
});

test("внешний класс объявляет политику, но не притворяется, что удаляет", async () => {
  const { service } = build({ enabled: true });
  const report = await service.enforce();
  const langfuse = report.classes.find((item) => item.code === "langfuse_metadata")!;
  assert.equal(langfuse.action, "external");
  assert.equal(langfuse.affected, 0);
  assert.equal(langfuse.days, 30);
  assert.match(langfuse.note ?? "", /внешней системы/);
});

// ---------------------------------------------------------------------
// Задержки удаления
// ---------------------------------------------------------------------

test("активная задержка останавливает удаление класса целиком", async () => {
  const { db, service } = build({ enabled: true });
  db.aged = { telegram_payload: 100, dead_letters: 50 };
  db.holds = ["telegram_payload"];

  const report = await service.enforce();

  const held = report.classes.find((item) => item.code === "telegram_payload")!;
  assert.equal(held.held, true);
  assert.equal(held.affected, 0);
  assert.equal(db.aged.telegram_payload, 100, "под задержкой не удаляется ничего");
  assert.match(held.note ?? "", /задержк/i);

  // Остальные классы задержка не трогает.
  assert.equal(db.aged.dead_letters, 0);
  const run = db.runs.find((row) => row.data_class === "telegram_payload")!;
  assert.equal(run.status, "skipped");
});

test("нечитаемые задержки запрещают удаление, а не разрешают его", async () => {
  const { db, service } = build({ enabled: true });
  db.aged = { telegram_payload: 100, dead_letters: 100 };
  db.failHolds = true;

  const report = await service.enforce();

  assert.equal(db.batches, 0, "при неизвестных задержках не удаляется ничего");
  assert.equal(db.aged.telegram_payload, 100);
  assert.ok(report.classes.every((item) => item.affected === 0));
});

test("редактирование payload сохраняет строку и её ключ идемпотентности", async () => {
  const { db, service } = build({ enabled: true });
  db.aged = { telegram_payload: 10 };
  await service.enforce();

  // Класс `telegram_payload` вычищает содержание, а не строку: удаление
  // строки — это другой класс с более длинным сроком.
  const payloadClass = RETENTION_CLASSES.find((item) => item.code === "telegram_payload")!;
  const idempotencyClass = RETENTION_CLASSES.find((item) => item.code === "telegram_idempotency")!;
  assert.equal(payloadClass.action, "redact");
  assert.equal(idempotencyClass.action, "delete");
  assert.ok(
    (idempotencyClass.defaultDays ?? 0) > (payloadClass.defaultDays ?? 0),
    "метаданные идемпотентности живут дольше содержания",
  );
});

test("фильтры статусов совпадают со схемой, а не с выдуманными значениями", () => {
  // Значения из `telegram_updates_status_check` и
  // `telegram_outbox_status_check`. Несуществующее значение в фильтре —
  // не синтаксическая ошибка: запрос выполняется, ничего не совпадает,
  // и политика молча не работает.
  const updateStatuses = new Set(["queued", "processing", "completed", "ignored", "retry", "dead"]);
  const outboxStatuses = new Set(["pending", "sending", "retry", "sent", "dead"]);

  const statements = Object.values(RETENTION_QUERIES)
    .flatMap((queries) => [...queries.count, ...(queries.apply ?? [])]);
  assert.ok(statements.length > 0);

  for (const sql of statements) {
    const used = [...sql.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
    const allowed = sql.includes("telegram_outbox") ? outboxStatuses : updateStatuses;
    for (const value of used) {
      // В запросах встречаются только статусы и пустой jsonb.
      if (value === "{}" || !/^[a-z_]+$/.test(value)) continue;
      if (!sql.includes("telegram_")) continue;
      assert.ok(allowed.has(value), `${value}: такого статуса в схеме нет`);
    }
  }

  // Точечно: обработанный апдейт получает `completed`, и именно он
  // должен попадать под удаление метаданных идемпотентности.
  const idempotency = RETENTION_QUERIES.telegram_idempotency!;
  assert.ok(idempotency.apply!.some((sql) => sql.includes("'completed'")));
  assert.ok(!idempotency.apply!.some((sql) => sql.includes("'done'")));

  // Payload исходящих вычищается только у завершённых строк: у
  // ожидающей доставки payload — это само сообщение.
  const payload = RETENTION_QUERIES.telegram_payload!;
  const outbox = payload.apply!.find((sql) => sql.includes("telegram_outbox"))!;
  assert.ok(outbox.includes("status IN ('sent', 'dead')"));
});

test("отчёт не раскрывает пользовательских данных", async () => {
  const { db, service } = build({ enabled: true });
  db.aged = { telegram_payload: 3 };
  const report = await service.enforce();
  const serialized = JSON.stringify(report);

  // В отчёте только классы, сроки и счётчики: ни идентификаторов, ни
  // текста, ни имён людей. Проверяются ИМЕНА ПОЛЕЙ, а не подстроки:
  // `telegram_idempotency` — это код класса данных, и запрещать его
  // из-за совпадения с `telegram_id` значило бы ловить собственный
  // словарь вместо утечки.
  assert.doesNotMatch(serialized, /"(user_id|telegram_id|chat_id|payload|text|message)"\s*:/i);
  for (const item of report.classes) {
    assert.deepEqual(
      Object.keys(item).sort().filter((key) => !["note"].includes(key)),
      ["action", "affected", "code", "days", "eligible", "held", "targets", "title"],
    );
  }
});
