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

import { HttpMediaSttClient, SttAdminService } from "../dist/admin/stt-service.js";

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
    await pool.query("DELETE FROM stt_route_providers");
    // Флаги маршрута тоже сбрасываются: тест, выключивший ротацию,
    // иначе оставит её выключенной следующему прогону — и «по умолчанию
    // включена» перестанет проверяться ровно тогда, когда сломается.
    await pool.query(
      "UPDATE stt_routes SET rotation_enabled = true, enabled = true, config_version = 1");
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
    await service.updateRoute("telegram_voice", { chain: [id] }, null);

    await assert.rejects(() => service.archive(id), /используется маршрутами/);

    await service.updateRoute("telegram_voice", { chain: [] }, null);
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
      () => service.updateRoute("telegram_voice", { chain: [id] }, null),
      /Архивная/,
    );
  });

  test("один провайдер не может стоять в цепочке дважды", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    const id = created.id as string;

    await assert.rejects(
      () => service.updateRoute("telegram_voice", { chain: [id, id] }, null),
      /вторые деньги/,
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
      () => service.updateRoute("telegram_voice", { chain: [rows[0].id] }, null),
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
      `SELECT c.status,
              (SELECT count(*)::int FROM stt_route_providers
                WHERE use_case = 'telegram_voice') AS chain_length
         FROM stt_provider_configs c WHERE c.id = $1`,
      [id],
    );
    assert.equal(rows[0].chain_length, 0, "цепочка не должна смениться");
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
    assert.deepEqual((route.chain as Array<{ config_id: string }>).map((l) => l.config_id), [id]);
    // Горячее применение: снимок ушёл в media-service сразу, без
    // перезапуска контейнеров.
    assert.equal(media.snapshots.length, 1);
    const snapshot = media.snapshots[0] as { configs: Array<{ secret: string }> };
    assert.equal(snapshot.configs[0]!.secret, "dg-live-key", "media-service нужен настоящий ключ");
  });

  test("активация переставляет провайдера в цепочке, а не задваивает", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const first = await service.create(deepgram(), null);
    const second = await service.create(deepgram({ name: "Deepgram запасной" }), null);

    await service.activate(first.id as string, "telegram_voice", "primary", null);
    await service.activate(second.id as string, "telegram_voice", "fallback", null);
    // Тот же провайдер во главу: он должен переехать, а не появиться дважды.
    await service.activate(second.id as string, "telegram_voice", "primary", null);

    const route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.deepEqual(
      (route.chain as Array<{ config_id: string }>).map((link) => link.config_id),
      [second.id, first.id],
    );
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
    await service.updateRoute("telegram_voice", { chain: [created.id] }, null);

    // Секрет пропал из хранилища — снимок должен уйти без висящей ссылки.
    secrets.values.clear();
    const pushed = await service.pushSnapshot();
    assert.equal(pushed.applied, true);
    const snapshot = media.snapshots.at(-1) as {
      configs: unknown[];
      routes: Array<{ chain: string[] }>;
    };
    assert.equal(snapshot.configs.length, 0);
    assert.deepEqual(
      snapshot.routes.flatMap((route) => route.chain),
      [],
      "ссылка на конфигурацию без ключа отправляться не должна",
    );
  });

  test("перенос MEDIA_ASR_* идемпотентен и не трогает готовый реестр", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };

    const env = {
      MEDIA_ASR_BASE_URL: "https://api.openai.com/v1",
      MEDIA_ASR_API_KEY: "sk-legacy-key",
      MEDIA_ASR_MODEL: "whisper-1",
      MEDIA_ASR_LANGUAGE: "ru",
    } as NodeJS.ProcessEnv;

    const first = await service.importLegacyEnv(env);
    assert.equal(first.imported, true);

    const configs = await service.list();
    assert.equal(configs.length, 1);
    assert.equal(configs[0]!.name, "migrated-default");
    assert.equal(configs[0]!.provider, "openai");
    assert.deepEqual(configs[0]!.public_config, { language: "ru" });
    // Ключ переехал в Secret Store, а не остался в параметрах.
    assert.ok(!JSON.stringify(configs).includes("sk-legacy-key"));
    assert.equal(secrets.values.get(secrets.puts[0]!.ref), "sk-legacy-key");

    const route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.deepEqual(
      (route.chain as Array<{ config_id: string }>).map((link) => link.config_id),
      [configs[0]!.id],
    );

    // Второй запуск ничего не меняет — иначе перезапуск сервиса
    // откатывал бы правки администратора.
    const second = await service.importLegacyEnv(env);
    assert.equal(second.imported, false);
    assert.equal((await service.list()).length, 1);
  });

  test("перенос не выполняется без настроенных MEDIA_ASR_*", async () => {
    await reset();
    const result = await service.importLegacyEnv({ MEDIA_ASR_MODEL: "whisper-1" } as NodeJS.ProcessEnv);
    assert.equal(result.imported, false);
    assert.equal((await service.list()).length, 0);
  });

  test("перенос определяет OpenRouter по адресу", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    await service.importLegacyEnv({
      MEDIA_ASR_BASE_URL: "https://openrouter.ai/api/v1",
      MEDIA_ASR_API_KEY: "or-key",
      MEDIA_ASR_MODEL: "openai/whisper-1",
    } as NodeJS.ProcessEnv);
    assert.equal((await service.list())[0]!.provider, "openrouter");
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

  // -------------------------------------------------------------------
  // цепочка провайдеров и ротация
  // -------------------------------------------------------------------
  test("цепочка хранит порядок, заданный администратором", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const one = await service.create(deepgram({ name: "Первый" }), null);
    const two = await service.create(deepgram({ name: "Второй" }), null);
    const three = await service.create(deepgram({ name: "Третий" }), null);
    const ids = [one.id, two.id, three.id] as string[];

    await service.updateRoute("telegram_voice", { chain: ids }, null);
    let route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.deepEqual(
      (route.chain as Array<{ name: string; position: number }>)
        .map((link) => [link.position, link.name]),
      [[0, "Первый"], [1, "Второй"], [2, "Третий"]],
    );

    // Порядок — это и есть приоритет: обратная перестановка должна
    // отразиться и в снимке, иначе панель врёт.
    await service.updateRoute("telegram_voice", { chain: [...ids].reverse() }, null);
    route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.deepEqual(
      (route.chain as Array<{ name: string }>).map((link) => link.name),
      ["Третий", "Второй", "Первый"],
    );
    const snapshot = media.snapshots.at(-1) as { routes: Array<{ chain: string[] }> };
    const telegram = snapshot.routes.find((item) => item.chain.length)!;
    assert.deepEqual(telegram.chain, [...ids].reverse());
  });

  test("цепочка длиннее шести не сохраняется", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const ids: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const created = await service.create(deepgram({ name: `Провайдер ${index}` }), null);
      ids.push(created.id as string);
    }
    await assert.rejects(
      () => service.updateRoute("telegram_voice", { chain: ids }, null),
      /Не больше 6/,
    );
  });

  test("выключатель ротации сохраняется и доезжает до media-service", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const created = await service.create(deepgram(), null);
    await service.updateRoute("telegram_voice", { chain: [created.id] }, null);

    // По умолчанию включена: установка, где резерв уже назначен, после
    // обновления обязана вести себя как прежде.
    let route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.equal(route.rotation_enabled, true);

    await service.updateRoute("telegram_voice", { rotation_enabled: false }, null);
    route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.equal(route.rotation_enabled, false);
    // Решает media-service, значит знать об этом должен он, а не панель.
    const snapshot = media.snapshots.at(-1) as {
      routes: Array<{ use_case: string; rotation_enabled: boolean }>;
    };
    assert.equal(
      snapshot.routes.find((item) => item.use_case === "telegram_voice")!.rotation_enabled,
      false,
    );

    // Правка цепочки не должна незаметно включать ротацию обратно.
    await service.updateRoute("telegram_voice", { chain: [created.id] }, null);
    route = (await service.routes()).find((item) => item.use_case === "telegram_voice")!;
    assert.equal(route.rotation_enabled, false);
  });

  test("недонастроенный резерв выпадает из снимка, но не рушит маршрут", async () => {
    await reset();
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return new FakeSecretStore().put.call(secrets, ref, value, usedBy);
    };
    const good = await service.create(deepgram({ name: "Рабочий" }), null);
    const weak = await service.create(deepgram({ name: "Слабый" }), null);
    await service.updateRoute("telegram_voice", { chain: [good.id, weak.id] }, null);

    // У второго пропал ключ из Secret Store.
    const { rows } = await pool.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM stt_provider_configs WHERE id = $1", [weak.id]);
    secrets.values.delete(rows[0]!.secret_ref);
    await pool.query("DELETE FROM stt_provider_keys WHERE config_id = $1", [weak.id]);

    await service.pushSnapshot();
    const snapshot = media.snapshots.at(-1) as {
      routes: Array<{ use_case: string; chain: string[] }>;
    };
    // Один недонастроенный резерв не должен положить распознавание
    // вместе с рабочим основным.
    assert.deepEqual(
      snapshot.routes.find((item) => item.use_case === "telegram_voice")!.chain,
      [good.id],
    );
  });

  // -------------------------------------------------------------------
  // несколько ключей на провайдера
  // -------------------------------------------------------------------
  /** Настраивает Secret Store так, чтобы FK на secret_records не падал. */
  const withSecretRows = () => {
    const originalPut = secrets.put.bind(secrets);
    secrets.put = async (ref, value, usedBy) => {
      await seedSecretRow(ref);
      return originalPut(ref, value, usedBy);
    };
  };

  /** Конфигурация на маршруте telegram_voice — так снимок доходит до media. */
  const routedDeepgram = async (overrides: Record<string, unknown> = {}) => {
    withSecretRows();
    const created = await service.create(deepgram(overrides), null);
    await service.updateRoute("telegram_voice", { chain: [created.id] }, null);
    return created.id as string;
  };

  test("ключей может быть несколько, и каждый лежит отдельной записью", async () => {
    await reset();
    const id = await routedDeepgram();
    await service.addKey(id, { api_key: "dg-second", label: "Резервный" }, null);
    await service.addKey(id, { api_key: "dg-third" }, null);

    const keys = await service.listKeys(id);
    assert.equal(keys.length, 3, "основной ключ плюс два добавленных");
    assert.deepEqual(keys.map((key) => key.label), ["Основной", "Резервный", "Ключ 3"]);

    // Ротация одного ключа не должна задевать остальные — значит, у
    // каждого своя запись в Secret Store.
    const refs = new Set(secrets.puts.map((put) => put.ref));
    assert.equal(refs.size, 3);
    for (const ref of refs) assert.match(ref, /^sec_stt_[0-9a-f_]+$/);
  });

  test("значения ключей не возвращаются из API ни в каком виде", async () => {
    await reset();
    const id = await routedDeepgram();
    await service.addKey(id, { api_key: "dg-очень-секретный", label: "Резервный" }, null);

    const dumped = JSON.stringify([
      await service.listKeys(id),
      await service.get(id),
      await service.list(),
    ]);
    assert.ok(!dumped.includes("dg-очень-секретный"));
    assert.ok(!dumped.includes("dg-live-key"));
  });

  test("в снимок для media-service уходят все включённые ключи по порядку", async () => {
    await reset();
    const id = await routedDeepgram();
    await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    await service.addKey(id, { api_key: "dg-third", label: "Третий" }, null);

    const snapshot = media.snapshots.at(-1) as {
      configs: Array<{ secret: string; keys: Array<{ label: string; secret: string }> }>;
    };
    const config = snapshot.configs[0]!;
    assert.deepEqual(config.keys.map((key) => key.secret), ["dg-live-key", "dg-second", "dg-third"]);
    assert.deepEqual(config.keys.map((key) => key.label), ["Основной", "Второй", "Третий"]);
    // Первый ключ дублируется в secret: снимок должна понимать и та
    // версия media-service, которая про список ещё не знает.
    assert.equal(config.secret, "dg-live-key");
  });

  test("выключенный ключ остаётся в списке, но выпадает из снимка", async () => {
    await reset();
    const id = await routedDeepgram();
    const added = await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    const keyId = (added.keys.find((key) => key.label === "Второй") as { id: string }).id;

    await service.updateKey(id, keyId, { enabled: false });

    const keys = await service.listKeys(id);
    assert.equal(keys.length, 2, "выключить и удалить — разные намерения");
    assert.equal(keys.find((key) => key.id === keyId)!.enabled, false);

    const snapshot = media.snapshots.at(-1) as { configs: Array<{ keys: unknown[] }> };
    assert.deepEqual(
      (snapshot.configs[0]!.keys as Array<{ secret: string }>).map((key) => key.secret),
      ["dg-live-key"],
    );
  });

  test("включение ключа снимает автоматическую пометку об исчерпании", async () => {
    await reset();
    const id = await routedDeepgram();
    const added = await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    const keyId = (added.keys.find((key) => key.label === "Второй") as { id: string }).id;

    await pool.query(
      `UPDATE stt_provider_keys
          SET status = 'exhausted', cooldown_until = now() + interval '1 day', enabled = false
        WHERE id = $1`,
      [keyId],
    );
    await service.updateKey(id, keyId, { enabled: true });

    const key = (await service.listKeys(id)).find((item) => item.id === keyId)!;
    // Администратор мог заменить ключ у провайдера — держать его в
    // остывании после ручного включения означало бы игнорировать это.
    assert.equal(key.status, "active");
    assert.equal(key.cooldown_until, null);
  });

  test("один и тот же ключ нельзя добавить дважды", async () => {
    await reset();
    const id = await routedDeepgram();
    await assert.rejects(
      () => service.addKey(id, { api_key: "dg-live-key", label: "Копия" }, null),
      /уже добавлен/,
    );
  });

  test("последний ключ работающей конфигурации не удаляется", async () => {
    await reset();
    const id = await routedDeepgram();
    const keys = await service.listKeys(id);
    await assert.rejects(
      () => service.removeKey(id, keys[0]!.id as string),
      /последний ключ/,
    );

    // С двумя ключами удаление разрешено, и указатель конфигурации
    // переезжает на оставшийся.
    await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    await service.removeKey(id, keys[0]!.id as string);

    const left = await service.listKeys(id);
    assert.deepEqual(left.map((key) => key.label), ["Второй"]);
    const { rows } = await pool.query<{ secret_ref: string }>(
      "SELECT secret_ref FROM stt_provider_configs WHERE id = $1", [id],
    );
    assert.equal(await secrets.get(rows[0]!.secret_ref), "dg-second");
  });

  test("проверка прогоняет все ключи, а не только первый", async () => {
    await reset();
    const id = await routedDeepgram();
    await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    await service.addKey(id, { api_key: "dg-third", label: "Третий" }, null);

    // Первый ключ отвергнут, второй упёрся в лимит, третий работает.
    const verdicts: Record<string, Record<string, unknown>> = {
      "dg-live-key": { success: false, error: { code: "stt_auth_failed", message: "401" } },
      "dg-second": { success: false, error: { code: "stt_rate_limited", message: "429" } },
      "dg-third": { success: true, latency_ms: 90, transcript: "тест" },
    };
    media.test = (async (config: { secret: string }) => verdicts[config.secret]) as never;

    const result = await service.test(id) as {
      success: boolean; keys: Array<Record<string, unknown>>;
    };
    assert.equal(result.success, true, "рабочий ключ есть — значит, конфигурация рабочая");
    assert.deepEqual(result.keys.map((key) => key.label), ["Основной", "Второй", "Третий"]);
    assert.deepEqual(result.keys.map((key) => key.success), [false, false, true]);
    assert.equal(result.keys[0]!.error_code, "stt_auth_failed");

    // Итог проверки виден в состоянии ключей: иначе панель показывала бы
    // «активен» тому, кого провайдер уже отверг.
    const stored = await service.listKeys(id);
    assert.equal(stored.find((key) => key.label === "Основной")!.status, "invalid");
    assert.equal(stored.find((key) => key.label === "Второй")!.status, "exhausted");
    assert.ok(stored.find((key) => key.label === "Второй")!.cooldown_until);
    assert.equal(stored.find((key) => key.label === "Третий")!.status, "active");
  });

  test("телеметрия распознавания переносит состояние ключей в базу", async () => {
    await reset();
    const id = await routedDeepgram();
    const added = await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    const second = (added.keys.find((key) => key.label === "Второй") as { id: string }).id;
    const first = (added.keys.find((key) => key.label === "Основной") as { id: string }).id;

    // Так выглядит успешное распознавание, которому пришлось сменить
    // ключ: пользователь ничего не заметил, панель обязана заметить.
    await service.recordUsage({
      useCase: "telegram_voice",
      audioSeconds: 4,
      attempts: [{
        config_id: id, provider: "deepgram", model: "nova-3", ok: true, latency_ms: 300,
        key_id: second, key_label: "Второй", keys_tried: 2,
        key_failures: [{ key_id: first, error_code: "stt_rate_limited" }],
      }],
    });

    const keys = await service.listKeys(id);
    const primary = keys.find((key) => key.id === first)!;
    const backup = keys.find((key) => key.id === second)!;
    assert.equal(primary.status, "exhausted");
    assert.equal(String(primary.failure_count), "1");
    assert.equal(backup.status, "active");
    assert.equal(String(backup.success_count), "1");
  });

  test("идентификатор ключа из media-service не доходит до запроса непроверенным", async () => {
    await reset();
    const id = await routedDeepgram();
    // media-service отдаёт псевдоидентификатор для конфигурации, чей
    // ключ ещё не попал в список. Приведение к uuid уронило бы всю
    // запись телеметрии вместе с ним.
    await service.recordUsage({
      useCase: "telegram_voice",
      audioSeconds: 4,
      attempts: [{
        config_id: id, provider: "deepgram", model: "nova-3", ok: true, latency_ms: 300,
        key_id: `${id}:0`, key_label: "Основной", keys_tried: 1,
      }],
    });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM stt_usage_events");
    assert.equal(rows[0].n, 1, "событие записано, несмотря на чужой формат идентификатора");
  });

  test("карточка показывает, сколько ключей и сколько из них живы", async () => {
    await reset();
    const id = await routedDeepgram();
    const added = await service.addKey(id, { api_key: "dg-second", label: "Второй" }, null);
    const second = (added.keys.find((key) => key.label === "Второй") as { id: string }).id;
    await pool.query("UPDATE stt_provider_keys SET status = 'exhausted' WHERE id = $1", [second]);

    const config = await service.get(id) as { keys: Record<string, number> };
    assert.equal(config.keys.total, 2);
    assert.equal(config.keys.usable, 1);
    assert.equal(config.keys.exhausted, 1);
  });
});

// ---------------------------------------------------------------------
// Общий секрет с media-service
// ---------------------------------------------------------------------
describe("аутентификация в media-service", () => {
  /** Secret Store, в котором записи нет — как на давно живущей установке. */
  const emptyStore = { async get() { return null; } } as never;

  const headersOf = async (client: HttpMediaSttClient) =>
    await (client as unknown as {
      headers(): Promise<Record<string, string>>;
    }).headers();

  test("токен берётся из окружения, когда в Secret Store его нет", async () => {
    // Ровно этот случай и давал HTTP 401 в панели при работающих
    // голосовых: копию в Secret Store кладёт bootstrap, а он проходит
    // один раз за жизнь установки. Появился MEDIA_SERVICE_TOKEN в .env
    // позже — записи нет, заголовок не отправлялся вовсе.
    const previous = process.env.MEDIA_SERVICE_TOKEN;
    process.env.MEDIA_SERVICE_TOKEN = "token-from-env";
    try {
      const headers = await headersOf(new HttpMediaSttClient(emptyStore));
      assert.equal(headers["x-media-key"], "token-from-env");
    } finally {
      if (previous === undefined) delete process.env.MEDIA_SERVICE_TOKEN;
      else process.env.MEDIA_SERVICE_TOKEN = previous;
    }
  });

  test("без переменной остаётся запасной путь через Secret Store", async () => {
    const previous = process.env.MEDIA_SERVICE_TOKEN;
    delete process.env.MEDIA_SERVICE_TOKEN;
    const store = { async get() { return "token-from-store"; } } as never;
    try {
      const headers = await headersOf(new HttpMediaSttClient(store));
      assert.equal(headers["x-media-key"], "token-from-store");
    } finally {
      if (previous !== undefined) process.env.MEDIA_SERVICE_TOKEN = previous;
    }
  });

  test("нет ни там, ни там — заголовок не выдумывается", async () => {
    const previous = process.env.MEDIA_SERVICE_TOKEN;
    delete process.env.MEDIA_SERVICE_TOKEN;
    try {
      const headers = await headersOf(new HttpMediaSttClient(emptyStore));
      // Пустой заголовок media-service отверг бы так же, как отсутствие,
      // но в логах это выглядело бы как «прислали неверный ключ».
      assert.equal("x-media-key" in headers, false);
      assert.equal(headers["content-type"], "application/json");
    } finally {
      if (previous !== undefined) process.env.MEDIA_SERVICE_TOKEN = previous;
    }
  });
});
