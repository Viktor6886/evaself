/**
 * Админ-слой реестра STT против настоящего PostgreSQL.
 *
 * Заглушка вместо базы здесь бесполезна: половина правил живёт в самой
 * схеме — уникальность имени, запрет совпадения primary и fallback,
 * запрет секретов в public_config, RESTRICT на занятую маршрутом
 * конфигурацию. Подделанный пул подтвердил бы только то, что запросы
 * формируются, а не то, что они делают.
 *
 * Тесты пропускаются, если базы нет: `make test` гоняет набор внутри
 * образа без PostgreSQL. Чтобы прогнать их, задайте
 * STT_TEST_DATABASE_URL на базу, где применены миграции.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import pg from "pg";

import { SttAdminService } from "../dist/admin/stt-service.js";

const DATABASE_URL = process.env.STT_TEST_DATABASE_URL ?? "";

// ---------------------------------------------------------------------
// заглушки внешних зависимостей
// ---------------------------------------------------------------------
/** Secret Store в памяти: шифрование проверяется своими тестами. */
class FakeSecretStore {
  values = new Map<string, string>();
  puts: Array<{ ref: string; usedBy: unknown }> = [];

  async put(ref: string, value: string, usedBy: unknown) {
    if (!/^sec_[a-z0-9_]+$/.test(ref)) {
      throw new Error(`secret_ref ${ref} не проходит ограничение Secret Store`);
    }
    this.values.set(ref, value);
    this.puts.push({ ref, usedBy });
    return { secret_ref: ref, configured: true };
  }

  async get(ref: string) {
    return this.values.get(ref) ?? null;
  }
}

/** media-service: принимает всё, если не сказано иначе. */
class FakeMediaClient {
  validateResult: { ok: boolean; errors: string[]; warnings: string[] } =
    { ok: true, errors: [], warnings: [] };
  testResult: Record<string, unknown> = { success: true, latency_ms: 120, transcript: "тест" };
  snapshots: unknown[] = [];
  seenSecrets: string[] = [];

  async providerSchemas() {
    return { providers: [{ provider: "deepgram" }] };
  }

  async validate(config: { secret: string }) {
    this.seenSecrets.push(config.secret);
    return this.validateResult;
  }

  async test() {
    return this.testResult;
  }

  async applySnapshot(snapshot: unknown) {
    this.snapshots.push(snapshot);
    return { applied: true, errors: [] };
  }
}

// ---------------------------------------------------------------------
describe("реестр STT-провайдеров", { skip: DATABASE_URL ? false : "нет STT_TEST_DATABASE_URL" }, () => {
  let pool: pg.Pool;
  let secrets: FakeSecretStore;
  let media: FakeMediaClient;
  let service: SttAdminService;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query("SELECT 1");
  });

  after(async () => {
    await pool?.end();
  });

  const reset = async () => {
    await pool.query("UPDATE stt_routes SET primary_config_id = NULL, fallback_config_id = NULL");
    await pool.query("DELETE FROM stt_usage_events");
    await pool.query("DELETE FROM stt_config_versions");
    await pool.query("DELETE FROM stt_provider_configs");
    await pool.query("DELETE FROM secret_records WHERE secret_ref LIKE 'sec_stt_%'");
    secrets = new FakeSecretStore();
    media = new FakeMediaClient();
    service = new SttAdminService(pool, secrets as never, media as never);
  };

  const deepgram = (overrides: Record<string, unknown> = {}) => ({
    name: "Deepgram production",
    provider: "deepgram",
    mode: "batch",
    base_url: "https://api.deepgram.com/v1/listen",
    model: "nova-3",
    public_config: { language: "ru", punctuate: true },
    api_key: "dg-live-key",
    ...overrides,
  });

  /** Secret Store подделан, поэтому FK на secret_records надо накормить. */
  const seedSecretRow = async (ref: string) => {
    await pool.query(
      // nonce ровно 12 байт, auth_tag ровно 16 — иначе не проходят
      // secret_records_nonce_check и secret_records_tag_check.
      `INSERT INTO secret_records (secret_ref, ciphertext, nonce, auth_tag, used_by_json)
       VALUES ($1, '\\x00',
               decode('000000000000000000000000', 'hex'),
               decode('00000000000000000000000000000000', 'hex'),
               '["media-service"]'::jsonb)
       ON CONFLICT (secret_ref) DO NOTHING`,
      [ref],
    );
  };

  // -------------------------------------------------------------------
  test("ключ не возвращается ни в одном ответе API", async () => {
    await reset();
    const originalPut = secrets.put.bind(secrets);
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return originalPut(ref, value, usedBy);
    };

    const created = await service.create(deepgram(), null);
    const fetched = await service.get(created.id as string);
    const listed = await service.list();

    for (const payload of [created, fetched, listed]) {
      const dumped = JSON.stringify(payload);
      assert.ok(!dumped.includes("dg-live-key"), "ключ просочился в ответ API");
      assert.ok(!dumped.includes("api_key"), "поле ключа не должно появляться в ответе");
    }
    const secret = created.secret as Record<string, unknown>;
    assert.equal(secret.configured, true);
    assert.match(String(secret.fingerprint), /^sha256:[0-9a-f]{12}$/);
  });

  test("secret_ref соответствует ограничению Secret Store", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    await service.create(deepgram(), null);
    // UUID с дефисами не прошёл бы ^sec_[a-z0-9_]+$ — отсюда конвенция.
    assert.match(secrets.puts[0]!.ref, /^sec_stt_[0-9a-f]{1,16}$/);
    assert.deepEqual(secrets.puts[0]!.usedBy, ["media-service"]);
  });

  test("секрет в открытых параметрах отклоняется", async () => {
    await reset();
    await assert.rejects(
      () => service.create(deepgram({ public_config: { api_key: "leak" } }), null),
      /Secret Store/,
    );
    await assert.rejects(
      () => service.create(deepgram({ public_config: { private_key: "leak" } })  , null),
      /Secret Store/,
    );
  });

  test("небезопасный base URL не сохраняется", async () => {
    await reset();
    for (const url of [
      "http://api.deepgram.com/v1/listen",
      "https://127.0.0.1/v1",
      "https://localhost/v1",
      "https://169.254.169.254/latest",
      "https://10.1.2.3/v1",
      "https://valkey.internal/v1",
      "file:///etc/passwd",
      "https://user:pw@api.deepgram.com/v1",
    ]) {
      await assert.rejects(
        () => service.create(deepgram({ base_url: url, name: `n-${url}` }), null),
        (error: Error) => /адрес|https|Учётные|внутренн|сам сервис/i.test(error.message),
        `адрес ${url} должен быть отклонён`,
      );
    }
  });

  test("приватный endpoint разрешается только явным флагом", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    await assert.rejects(
      () => service.create(deepgram({ base_url: "https://192.168.1.50/v1" }), null),
      /внутреннюю сеть/,
    );
    const created = await service.create(
      deepgram({ base_url: "https://192.168.1.50/v1", allow_private_endpoint: true }),
      null,
    );
    assert.equal(created.base_url, "https://192.168.1.50/v1");
  });

  test("отказ адаптера отменяет сохранение", async () => {
    await reset();
    media.validateResult = { ok: false, errors: ["keyterm поддерживает только nova-3"], warnings: [] };

    await assert.rejects(() => service.create(deepgram(), null), /nova-3/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM stt_provider_configs");
    assert.equal(rows[0].n, 0, "при отказе адаптера строка не должна появиться");
  });

  test("дубль названия отклоняется понятным сообщением", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    await service.create(deepgram(), null);
    await assert.rejects(
      () => service.create(deepgram({ provider: "openai", base_url: "https://api.openai.com/v1", model: "whisper-1" })),
      /уже есть|менять нельзя/,
    );
  });

  test("пустое поле ключа при редактировании сохраняет прежний", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    media.seenSecrets = [];

    await service.update(created.id as string, { model: "nova-3-general" }, null);

    // Валидатору ушёл прежний ключ, а не пустая строка — иначе каждое
    // сохранение формы требовало бы заново вводить ключ.
    assert.equal(media.seenSecrets.at(-1), "dg-live-key");
    assert.equal(secrets.values.size, 1, "новый секрет не должен создаваться");
  });

  test("правка параметров снимает признак здоровья", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;
    await pool.query("UPDATE stt_provider_configs SET status = 'healthy', last_test_ok = true WHERE id = $1", [id]);

    const updated = await service.update(id, { model: "nova-2" }, null);
    assert.equal(updated.status, "draft", "изменённая конфигурация не может считаться проверенной");
  });

  test("конфликт версий ловится оптимистической блокировкой", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;
    await service.update(id, { model: "nova-3-general" }, null);

    await assert.rejects(
      () => service.update(id, { model: "whisper-large", config_version: 1 }, null),
      /изменена другим администратором/,
    );
  });

  test("откат возвращает прежние параметры, но не ключ", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;
    await service.update(id, { model: "сломанная-модель", public_config: {} }, null);

    const rolled = await service.rollback(id, null);
    assert.equal(rolled.model, "nova-3");
    assert.deepEqual(rolled.public_config, { language: "ru", punctuate: true });
    const dumped = JSON.stringify(rolled);
    assert.ok(!dumped.includes("dg-live-key"));

    const { rows } = await pool.query(
      "SELECT snapshot_json FROM stt_config_versions WHERE config_id = $1", [id],
    );
    for (const row of rows) {
      const snapshot = JSON.stringify(row.snapshot_json);
      assert.ok(!snapshot.includes("dg-live-key"), "снимок версии не должен содержать ключ");
    }
  });

  test("занятую маршрутом конфигурацию архивировать нельзя", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;
    await service.updateRoute("telegram_voice", { primary_config_id: id }, null);

    await assert.rejects(() => service.archive(id), /используется маршрутами/);

    await service.updateRoute("telegram_voice", { primary_config_id: null }, null);
    const archived = await service.archive(id);
    assert.equal(archived.archived, true);
    assert.equal(archived.status, "archived");
  });

  test("архивная конфигурация не назначается на маршрут", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;
    await service.archive(id);

    await assert.rejects(
      () => service.updateRoute("telegram_voice", { primary_config_id: id }, null),
      /Архивная/,
    );
  });

  test("резерв не может совпадать с основным", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;

    await assert.rejects(
      () => service.updateRoute("telegram_voice", {
        primary_config_id: id, fallback_config_id: id,
      }, null),
      /не могут совпадать/,
    );
  });

  test("конфигурация без ключа на маршрут не назначается", async () => {
    await reset();
    const { rows } = await pool.query(
      `INSERT INTO stt_provider_configs (name, provider, base_url, model)
       VALUES ('Без ключа', 'openai', 'https://api.openai.com/v1', 'whisper-1')
       RETURNING id`,
    );
    await assert.rejects(
      () => service.updateRoute("telegram_voice", { primary_config_id: rows[0].id }, null),
      /не задан ключ/,
    );
  });

  test("неизвестный сценарий отклоняется", async () => {
    await reset();
    await assert.rejects(
      () => service.updateRoute("выдуманный_сценарий", {}, null),
      /Неизвестный сценарий/,
    );
  });

  test("активация не проходит, если проверка провалилась", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;
    media.testResult = { success: false, error: { code: "stt_auth_failed", message: "ключ не принят" } };

    await assert.rejects(() => service.activate(id, "telegram_voice", "primary", null), /Активация отменена/);

    const { rows } = await pool.query(
      "SELECT primary_config_id, status FROM stt_routes r, stt_provider_configs c WHERE r.use_case = 'telegram_voice' AND c.id = $1",
      [id],
    );
    assert.equal(rows[0].primary_config_id, null, "маршрут не должен смениться");
    assert.equal(rows[0].status, "unhealthy");
  });

  test("успешная активация переводит маршрут и рассылает снимок", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;

    await service.activate(id, "telegram_voice", "primary", null);

    const routes = await service.routes();
    const route = routes.find((item) => item.use_case === "telegram_voice")!;
    assert.equal(route.primary_config_id, id);
    // Горячее применение: снимок ушёл в media-service сразу, без
    // перезапуска контейнеров.
    assert.equal(media.snapshots.length, 1);
    const snapshot = media.snapshots[0] as { configs: Array<{ secret: string }> };
    assert.equal(snapshot.configs[0]!.secret, "dg-live-key", "media-service нужен настоящий ключ");
  });

  test("активация в резерв снимает конфигурацию с роли основного", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const primary = await service.create(deepgram(), null);
    const id = primary.id as string;
    await service.activate(id, "telegram_voice", "primary", null);
    await service.activate(id, "telegram_voice", "fallback", null);

    const route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.equal(route.fallback_config_id, id);
    assert.equal(route.primary_config_id, null, "одна конфигурация не может быть и основной, и резервной");
  });

  test("телеметрия различает запросы, попытки и события резерва", async () => {
    await reset();
    await service.recordUsage({
      useCase: "telegram_voice",
      audioSeconds: 12.5,
      idempotencyKey: "file-unique-1",
      attempts: [
        { provider: "deepgram", model: "nova-3", ok: false, latency_ms: 900, error_code: "stt_rate_limited" },
        { provider: "openai", model: "whisper-1", ok: true, latency_ms: 1500, is_fallback: true },
      ],
    });

    const usage = await service.usage(30) as {
      totals: Record<string, string | number>;
    };
    // Одно голосовое сообщение: одно распознавание для пользователя,
    // две попытки провайдеров, одно событие fallback.
    assert.equal(Number(usage.totals.requests), 1);
    assert.equal(Number(usage.totals.attempts), 2);
    assert.equal(Number(usage.totals.fallbacks), 1);
    assert.equal(Number(usage.totals.successes), 1);
    assert.equal(Number(usage.totals.failures), 1);
    // Длительность считается один раз, а не по разу на провайдера.
    assert.equal(Number(usage.totals.audio_seconds), 12.5);
  });

  test("снимок не содержит конфигураций без ключа", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    await service.updateRoute("telegram_voice", { primary_config_id: created.id }, null);

    // Секрет пропал из хранилища — снимок должен уйти без висящей ссылки.
    secrets.values.clear();
    const pushed = await service.pushSnapshot();
    assert.equal(pushed.applied, true);
    const snapshot = media.snapshots.at(-1) as {
      configs: unknown[];
      routes: Array<{ primary_config_id: string | null }>;
    };
    assert.equal(snapshot.configs.length, 0);
    assert.equal(
      snapshot.routes.find((route) => route.primary_config_id)?.primary_config_id,
      undefined,
      "ссылка на конфигурацию без ключа отправляться не должна",
    );
  });

  test("Google: путь к файлу не сохраняется, а неполный JSON отклоняется", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const google = (credentials: unknown) => ({
      name: "Google prod",
      provider: "google",
      mode: "batch",
      base_url: "https://speech.googleapis.com",
      model: "chirp_2",
      public_config: { location: "us-central1", language_codes: ["ru-RU"] },
      credentials_json: credentials,
    });

    await assert.rejects(
      () => service.create(google(JSON.stringify({ type: "service_account", project_id: "p" })), null),
      /private_key/,
    );
    await assert.rejects(() => service.create(google("не json"), null), /не разбирается как JSON/);
    await assert.rejects(
      () => service.create(google(JSON.stringify({
        type: "authorized_user", project_id: "p", private_key: "k",
        client_email: "e@x", token_uri: "https://oauth2.googleapis.com/token",
      })), null),
      /service_account/,
    );

    const full = {
      type: "service_account",
      project_id: "eva-prod",
      private_key_id: "kid-1",
      private_key: "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n",
      client_email: "stt@eva-prod.iam.gserviceaccount.com",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const created = await service.create(google(JSON.stringify(full)), null);

    const dumped = JSON.stringify(created);
    assert.ok(!dumped.includes("SECRET"), "приватный ключ не должен вернуться в браузер");
    assert.ok(!dumped.includes("private_key"));
    // Целиком JSON лежит в Secret Store, а не в конфигурации.
    assert.ok(secrets.values.get(secrets.puts[0]!.ref)!.includes("SECRET"));
    const { rows } = await pool.query(
      "SELECT public_config::text AS text FROM stt_provider_configs WHERE id = $1",
      [created.id],
    );
    assert.ok(!rows[0].text.includes("SECRET"));
  });
});
