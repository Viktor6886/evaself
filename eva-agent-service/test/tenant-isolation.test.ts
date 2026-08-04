/**
 * Граница арендатора.
 *
 * Проверяется не текст SQL, а поведение: обращение к пользовательским
 * данным вне объявленной области не выполняется вовсе, подменённый
 * идентификатор не проходит, чужие строки не попадают даже во временный
 * результат поиска, а административный доступ требует роли и записи
 * аудита.
 *
 * Отдельно — статическая проверка всего исходного кода: каждый запрос к
 * пользовательской таблице обязан либо иметь границу, либо быть явно
 * объявленным системным или административным.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";

import Fastify from "fastify";

import {
  adminScope,
  analyzeSql,
  assertQueryAllowed,
  runInScope,
  systemScope,
  TenantViolationError,
  userScope,
} from "../dist/tenancy/index.js";
import { buildAdminServer } from "../dist/admin/server.js";
import { adminUnauthorized } from "../dist/admin/errors.js";
import { GraphContextService } from "../dist/memory/graph-context.js";
import { registerWebappCoreRoutes } from "../dist/public/webapp-core.js";
import { TaskEventService } from "../dist/tasks/task-event-service.js";
import { withTenantScopes } from "./tenant-scope-helper.ts";

const BOT_TOKEN = "123456789:abcdefghijklmnopqrstuvwxyzABCDEFG";
const ANNA = { id: 100_001, internalId: 11, first_name: "Анна" };
const BORIS = { id: 100_002, internalId: 22, first_name: "Борис" };

// ---------------------------------------------------------------------
// 1. Без области пользовательские данные недоступны вовсе
// ---------------------------------------------------------------------

test("запрос к пользовательской таблице вне области не выполняется", () => {
  assert.throws(
    () => assertQueryAllowed("SELECT * FROM eva_notes WHERE user_id = $1", [11]),
    TenantViolationError,
  );
  // Общие таблицы границы не требуют: настройки принадлежат установке.
  assertQueryAllowed("SELECT * FROM sdk_settings WHERE id = 1", []);
});

test("внутри области пользователя запрос без ограничения по владельцу отвергается", () => {
  const scope = userScope({ userId: ANNA.internalId, label: "тест" });
  runInScope(scope, async () => {
    assert.throws(
      () => assertQueryAllowed("SELECT id, title FROM eva_notes ORDER BY id", []),
      /без ограничения по пользователю/,
    );
    assertQueryAllowed("SELECT id FROM eva_notes WHERE user_id = $1", [ANNA.internalId]);
  });
});

test("подменённый идентификатор не проходит границу", () => {
  const scope = userScope({
    userId: ANNA.internalId,
    telegramId: ANNA.id,
    label: "тест",
  });
  runInScope(scope, async () => {
    assert.throws(
      () => assertQueryAllowed(
        "UPDATE eva_notes SET title = $3 WHERE id = $1 AND user_id = $2",
        [5, BORIS.internalId, "чужая заметка"],
      ),
      /не совпадает с пользователем/,
    );
    assert.throws(
      () => assertQueryAllowed(
        "SELECT metric FROM v_quota_status WHERE telegram_id = $1",
        [BORIS.id],
      ),
      /не совпадает с пользователем/,
    );
  });
});

test("идентификатор-строка из драйвера не отвергает собственный запрос владельца", () => {
  // `users.id` и `telegram_id` — bigint, и pg отдаёт их строкой. Пока
  // область сравнивала «1» с 1, граница отвергала запрос пользователя к
  // его же данным: ход в Telegram и создание агента падали целиком.
  const scope = userScope({
    userId: "41" as unknown as number,
    telegramId: "424242" as unknown as number,
    label: "тест",
  });
  runInScope(scope, async () => {
    assertQueryAllowed(
      "INSERT INTO agent_links (user_id, agent_id) VALUES ($1, $2)",
      ["41", "agent-1"],
    );
    assertQueryAllowed("SELECT id FROM eva_notes WHERE user_id = $1", [41]);
    assert.throws(
      () => assertQueryAllowed("SELECT id FROM eva_notes WHERE user_id = $1", ["42"]),
      /не совпадает с пользователем/,
    );
  });
});

test("имя таблицы со схемой или в кавычках не проходит мимо границы", () => {
  // Разбор шёл по голому идентификатору, поэтому `public.eva_notes` и
  // `"eva_notes"` выглядели запросом, не касающимся пользовательских
  // данных: они выполнялись бы вообще вне какой-либо области.
  for (const sql of [
    "SELECT * FROM public.eva_notes",
    'SELECT * FROM "eva_notes"',
    "UPDATE public.tasks SET title = $1",
    "DELETE FROM public.budget_entries WHERE id = $1",
  ]) {
    assert.throws(() => assertQueryAllowed(sql, [1]), TenantViolationError, sql);
  }
  // Квалифицированный запрос с владельцем по-прежнему проходит.
  runInScope(userScope({ userId: ANNA.internalId, label: "тест" }), async () => {
    assertQueryAllowed(
      "INSERT INTO public.eva_notes (user_id, title) VALUES ($1, $2)",
      [ANNA.internalId, "своё"],
    );
  });
});

test("один алиас на две таблицы не выдаёт ограничение одной за другую", () => {
  // Привязка закреплялась по имени алиаса, поэтому `g` из первого
  // подзапроса «ограничивал» и `tasks` из второго — а тот читался бы
  // целиком, по всем пользователям.
  const sql = `SELECT (SELECT count(*) FROM goals g WHERE g.user_id = $1) AS a,
                      (SELECT title FROM tasks g LIMIT 1) AS b`;
  const analysis = analyzeSql(sql);
  assert.deepEqual(analysis.unscoped.sort(), ["goals", "tasks"]);
  runInScope(userScope({ userId: ANNA.internalId, label: "тест" }), async () => {
    assert.throws(() => assertQueryAllowed(sql, [ANNA.internalId]), TenantViolationError);
  });
});

test("системная область без объявленного crossUser не даёт сплошной выборки", () => {
  runInScope(systemScope("тест"), async () => {
    assert.throws(
      () => assertQueryAllowed("SELECT id FROM tasks WHERE status = 'open'", []),
      /не объявила доступ к данным/,
    );
    assertQueryAllowed("SELECT id FROM tasks WHERE user_id = $1", [BORIS.internalId]);
  });
  runInScope(systemScope("тест", { crossUser: true }), async () => {
    assertQueryAllowed("SELECT id FROM tasks WHERE status = 'open'", []);
  });
});

// ---------------------------------------------------------------------
// 2. Административный доступ: роль и аудит
// ---------------------------------------------------------------------

test("административный доступ к данным пользователей требует записи аудита", () => {
  const withoutAudit = adminScope({
    actor: "operator",
    role: "admin",
    route: "GET /api/admin/v1/users",
  });
  runInScope(withoutAudit, async () => {
    assert.throws(
      () => assertQueryAllowed("SELECT id, telegram_id FROM v_user_overview LIMIT 50", []),
      /не зафиксировано в аудите/,
    );
  });
  const audited = adminScope({
    actor: "operator",
    role: "admin",
    auditId: "audit-1",
    route: "GET /api/admin/v1/users",
  });
  runInScope(audited, async () => {
    assertQueryAllowed("SELECT id, telegram_id FROM v_user_overview LIMIT 50", []);
  });
});

test("административные маршруты с доступом к данным пользователей объявляют роли", async () => {
  const source = readFileSync(sourcePath("admin/server.ts"), "utf8");
  const blocks = source.split("tenantAccess: \"cross-user\"");
  assert.ok(blocks.length > 1, "маршруты с доступом к данным пользователей не размечены");
  for (const block of blocks.slice(0, -1)) {
    const configuration = block.slice(-400);
    assert.match(configuration, /roles: \[/, "маршрут без ролей");
  }
});

// ---------------------------------------------------------------------
// 3. Матрица из двух пользователей на настоящих обработчиках Mini App
// ---------------------------------------------------------------------

interface StoredRow extends Record<string, unknown> {
  id: number;
  user_id: number;
}

/**
 * Поддельная база, которая уважает владельца.
 *
 * Она не исполняет SQL целиком: из запроса берётся таблица и владелец,
 * которого потребовал сам запрос, и возвращаются только строки этого
 * владельца. Этого достаточно, чтобы отличить «пользователь видит своё»
 * от «пользователь видит чужое», не поднимая PostgreSQL.
 */
function ownershipAwareDatabase(rows: Record<string, StoredRow[]>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const owners = new Map<number, number>([
    [ANNA.id, ANNA.internalId],
    [BORIS.id, BORIS.internalId],
  ]);
  return {
    statements,
    database: withTenantScopes({
      query: async (sql: string, values: unknown[] = []) => {
        statements.push({ sql, values });
        const analysis = analyzeSql(sql);
        const table = analysis.uses[0]?.table ?? "";
        if (table === "users") {
          const telegramId = Number(values[0]);
          const internalId = owners.get(telegramId);
          return {
            rows: internalId
              ? [{ id: String(internalId), timezone: "Europe/Moscow" }]
              : [],
            rowCount: internalId ? 1 : 0,
          };
        }
        const requested = requestedOwner(analysis, values);
        const table_rows = (rows[table] ?? []).filter(
          (row) => requested === null || row.user_id === requested,
        );
        const matching = matchesId(sql, values, table_rows);
        return { rows: matching, rowCount: matching.length };
      },
    }),
  };
}

function requestedOwner(
  analysis: ReturnType<typeof analyzeSql>,
  values: unknown[],
): number | null {
  for (const binding of analysis.bindings) {
    if (binding.kind !== "parameter" || binding.column !== "user_id") continue;
    const value = Number(values[binding.index - 1]);
    if (Number.isSafeInteger(value)) return value;
  }
  return null;
}

/** `WHERE id = $1` в запросах Mini App всегда первый параметр. */
function matchesId(sql: string, values: unknown[], rows: StoredRow[]): StoredRow[] {
  if (!/\bid = \$1\b/.test(sql)) return rows;
  const id = Number(values[0]);
  return rows.filter((row) => row.id === id);
}

async function miniApp(rows: Record<string, StoredRow[]>) {
  const { database, statements } = ownershipAwareDatabase(rows);
  const app = Fastify({ logger: false });
  registerWebappCoreRoutes(app, {
    config: {
      telegramBotToken: BOT_TOKEN,
      telegramWebAppMaxAgeSeconds: 600,
      publicRateLimitPerIp: 1_000,
      publicRateLimitPerUser: 1_000,
      rateLimitWindowSeconds: 60,
    } as never,
    db: database as never,
    now: () => new Date("2026-08-04T10:00:00.000Z"),
  });
  await app.ready();
  return { app, statements };
}

function initDataFor(user: { id: number; first_name: string }): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(new Date("2026-08-04T10:00:00.000Z").getTime() / 1000)),
    query_id: "AAEAAAE",
    user: JSON.stringify({ id: user.id, first_name: user.first_name }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

const NOTES: Record<string, StoredRow[]> = {
  eva_notes: [
    { id: 1, user_id: ANNA.internalId, title: "Заметка Анны", content: "личное" },
    { id: 2, user_id: BORIS.internalId, title: "Заметка Бориса", content: "личное" },
  ],
  tasks: [
    { id: 10, user_id: ANNA.internalId, title: "Задача Анны" },
    { id: 20, user_id: BORIS.internalId, title: "Задача Бориса" },
  ],
};

test("каждый из двух пользователей видит только свои записи", async () => {
  const { app } = await miniApp(NOTES);
  for (const [user, expected] of [
    [ANNA, "Заметка Анны"],
    [BORIS, "Заметка Бориса"],
  ] as const) {
    const response = await app.inject({
      method: "GET",
      url: "/public/v2/notes",
      headers: { "x-telegram-init-data": initDataFor(user) },
    });
    assert.equal(response.statusCode, 200);
    const notes = (response.json() as { notes: StoredRow[] }).notes;
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.title, expected);
  }
  await app.close();
});

test("чужой объект не читается и не изменяется подменой идентификатора", async () => {
  const { app } = await miniApp(NOTES);
  const foreign = await app.inject({
    method: "PATCH",
    url: "/public/v2/notes/2",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
    payload: { title: "переписано" },
  });
  assert.equal(foreign.statusCode, 404);

  const own = await app.inject({
    method: "PATCH",
    url: "/public/v2/notes/1",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
    payload: { title: "своё" },
  });
  assert.equal(own.statusCode, 200);

  const foreignTask = await app.inject({
    method: "DELETE",
    url: "/public/v2/tasks/20",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
  });
  assert.equal(foreignTask.statusCode, 404);
  await app.close();
});

test("идентификатор из тела запроса не меняет владельца", async () => {
  const { app, statements } = await miniApp(NOTES);
  const response = await app.inject({
    method: "POST",
    url: "/public/v2/notes",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
    payload: { title: "Заметка", content: "текст", user_id: BORIS.internalId },
  });
  assert.equal(response.statusCode, 201);
  const insert = statements.find((item) => item.sql.includes("INSERT INTO eva_notes"));
  assert.ok(insert, "вставка не выполнялась");
  assert.equal(insert!.values[0], ANNA.internalId);
  assert.ok(!insert!.values.includes(BORIS.internalId));
  await app.close();
});

test("ссылка на чужой рабочий блок отвергается до записи", async () => {
  const { app } = await miniApp({
    ...NOTES,
    work_blocks: [{ id: 55, user_id: BORIS.internalId }],
    eva_focus_sessions: [],
  });
  const response = await app.inject({
    method: "POST",
    url: "/public/v2/focus-sessions",
    headers: { "x-telegram-init-data": initDataFor(ANNA) },
    payload: { title: "Фокус", work_block_id: 55 },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

// ---------------------------------------------------------------------
// 4. Поиск: чужие кандидаты не попадают даже во временный результат
// ---------------------------------------------------------------------

test("графовый поиск ограничивает кандидатов до ранжирования", async () => {
  const statements: string[] = [];
  const service = new GraphContextService(
    withTenantScopes({
      query: async () => ({ rows: [], rowCount: 0 }),
      transaction: async (work: (client: {
        query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
      }) => Promise<unknown>) => await work({
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [{ nodes: [], edges: [] }] };
        },
      }),
    }) as never,
    { enabled: true },
  );
  await runInScope(
    userScope({ userId: ANNA.internalId, label: "тест" }),
    async () => await service.findRelevant(ANNA.internalId, "почему я снова откладываю цель"),
  );
  const search = statements.find((sql) => sql.includes("memory_nodes"));
  assert.ok(search, "графовый поиск не выполнялся");
  const seed = search!.slice(search!.indexOf("seed AS"), search!.indexOf("walk("));
  // Ограничение по владельцу стоит внутри выборки кандидатов, а не
  // после неё: иначе чужие узлы успели бы попасть в ранжирование.
  assert.match(seed, /n\.user_id = \$1/);
  assert.ok(
    seed.indexOf("n.user_id = $1") < seed.indexOf("ORDER BY score"),
    "фильтр владельца применяется после ранжирования",
  );
});

test("поиск по графу без фильтра владельца не выполняется", () => {
  runInScope(userScope({ userId: ANNA.internalId, label: "тест" }), async () => {
    assert.throws(
      () => assertQueryAllowed(
        `SELECT n.id FROM memory_nodes n
          WHERE n.status = 'active'
          ORDER BY n.updated_at DESC LIMIT 12`,
        [],
      ),
      /без ограничения по пользователю/,
    );
  });
});

test("события задач читаются только вместе с владельцем задачи", async () => {
  const seen: string[] = [];
  const events = new TaskEventService(withTenantScopes({
    query: async (sql: string) => {
      seen.push(sql);
      return { rows: [], rowCount: 0 };
    },
  }) as never);
  await runInScope(
    userScope({ userId: ANNA.internalId, label: "тест" }),
    async () => await events.recent(ANNA.internalId, 5),
  );
  assert.match(seen[0] ?? "", /t\.user_id = e\.user_id/);
});

// ---------------------------------------------------------------------
// 5. Статическая проверка всего исходного кода
// ---------------------------------------------------------------------

/**
 * Пометка, объявляющая, почему у запроса нет границы по владельцу.
 * Формат общий с `scripts/ci/assert-tenant-scope.py`:
 *
 *     -- tenant: system — почему это общесистемная операция
 *     -- tenant: by <ключ> — через какой ключ владельца идёт ограничение
 *
 * Причина обязана быть причиной: `--` комментирует строку до конца, и
 * «пометка», за которой идёт SQL, означала бы закомментированный запрос.
 */
const TENANT_MARKER =
  /--\s*tenant:\s*(?:system|by\s+[a-z_][a-z0-9_]*)\s*(?:—|-|:)?\s*(.{12,})/i;

test("во всём исходном коде нет запроса к данным пользователя без границы", () => {
  const root = sourcePath("");
  const unexpected: string[] = [];
  for (const file of sourceFiles(root)) {
    const relativePath = relative(root, file);
    const source = readFileSync(file, "utf8");
    for (const [sql, line] of sqlLiterals(source)) {
      const analysis = analyzeSql(sql);
      if (analysis.uses.length === 0 || analysis.unscoped.length === 0) continue;
      // Исключение объявляется у самого запроса, а не у файла: иначе
      // один общесистемный SELECT выводил бы из-под проверки весь
      // модуль вместе с будущими запросами в нём.
      const marker = TENANT_MARKER.exec(sql);
      const reason = marker?.[1]?.trim() ?? "";
      if (reason && !/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(reason)) {
        continue;
      }
      unexpected.push(
        `${relativePath}:${line} — ${analysis.unscoped.join(", ")}`,
      );
    }
  }
  assert.deepEqual(unexpected, []);
});

test("мимо границы в PostgreSQL ходить неоткуда: пулы создаются только под защитой", () => {
  const root = sourcePath("");
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    if (!/new Pool\(|new pg\.Pool\(/.test(source)) continue;
    const relativePath = relative(root, file);
    // db.ts оборачивает собственный пул своим же прокси, остальные —
    // guardPool из модуля границы.
    assert.ok(
      /guardPool\(/.test(source) || relativePath === "db.ts",
      `${relativePath}: пул PostgreSQL создан без границы арендатора`,
    );
  }
});

function sourcePath(relativePath: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "src", relativePath);
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

/** Литералы SQL из исходника: обратные кавычки и обычные строки. */
function* sqlLiterals(source: string): Generator<[string, number]> {
  const patterns = [/`([^`]*?)`/gs, /"((?:[^"\\]|\\.)*)"/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const sql = match[1] ?? "";
      if (!/\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql)) continue;
      yield [sql, source.slice(0, match.index).split("\n").length];
    }
  }
}

// ---------------------------------------------------------------------
// 6. Административная поверхность целиком: роль, аудит, область
// ---------------------------------------------------------------------

test("административный запрос к данным пользователей идёт под ролью и аудитом", async () => {
  const audits: Array<{ operation: string; id: string }> = [];
  const attempted: string[] = [];
  const session = {
    id: "session-1",
    user: { id: "1", username: "owner", role: "owner" },
  };
  const app = buildAdminServer({
    auth: {
      authenticate: async () => session,
      requireCsrf: () => undefined,
      requireSudo: async () => undefined,
    },
    audit: {
      start: async (entry: { operation: string }) => {
        const id = `audit-${audits.length + 1}`;
        audits.push({ operation: entry.operation, id });
        return { id, startedAt: Date.now() };
      },
      finish: async () => undefined,
      list: async () => [],
    },
    users: {
      list: async () => {
        // Настоящий запрос админки к пользовательским данным: он обязан
        // пройти границу, а значит требует области с записью аудита.
        attempted.push("list");
        assertQueryAllowed(
          "SELECT id, telegram_id FROM v_user_overview ORDER BY id LIMIT 50",
          [],
        );
        return { total: 0, users: [] };
      },
    },
    config: {}, secrets: {}, health: {}, operations: {}, providers: {},
    llmRouter: {}, stt: {}, integrations: {},
    events: { publish: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    readiness: async () => true,
  } as never);
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/api/admin/v1/users",
    headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(attempted, ["list"]);
  assert.equal(audits.length, 1, "чтение данных пользователей не попало в аудит");
  assert.match(audits[0]!.operation, /\/api\/admin\/v1\/users/);
  await app.close();
});

test("неаутентифицированный запрос не пишет в журнал аудита", async () => {
  // Запись создавалась до проверки сессии, поэтому поток чужих GET
  // раздувал бы журнал, ничего о себе не сообщая. Для небезопасных
  // методов запись по-прежнему делается заранее — там она и нужна.
  const audits: string[] = [];
  let attempts = 0;
  const app = buildAdminServer({
    auth: {
      authenticate: async () => {
        throw adminUnauthorized();
      },
      requireCsrf: () => undefined,
      requireSudo: async () => undefined,
    },
    audit: {
      start: async (entry: { operation: string }) => {
        audits.push(entry.operation);
        return { id: `audit-${audits.length}`, startedAt: Date.now() };
      },
      finish: async () => undefined,
    },
    users: {
      list: async () => {
        attempts += 1;
        return { total: 0, users: [] };
      },
    },
    config: {}, secrets: {}, health: {}, operations: {}, providers: {},
    llmRouter: {}, stt: {}, integrations: {},
    events: { publish: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    readiness: async () => true,
  } as never);
  await app.ready();

  const response = await app.inject({ method: "GET", url: "/api/admin/v1/users" });
  assert.equal(response.statusCode, 401);
  assert.equal(attempts, 0);
  assert.deepEqual(audits, []);
  await app.close();
});

test("чтение переписки идёт под одной записью аудита, называющей пользователя", async () => {
  const audits: Array<{ operation: string; params: unknown }> = [];
  const session = {
    id: "session-1",
    user: { id: "1", username: "owner", role: "owner" },
  };
  const app = buildAdminServer({
    auth: {
      authenticate: async () => session,
      requireCsrf: () => undefined,
      requireSudo: async () => undefined,
    },
    audit: {
      start: async (entry: { operation: string; params: unknown }) => {
        audits.push({ operation: entry.operation, params: entry.params });
        return { id: `audit-${audits.length}`, startedAt: Date.now() };
      },
      finish: async () => undefined,
    },
    users: {
      conversation: async () => {
        // Настоящее обращение к данным пользователя: без записи аудита в
        // области граница его не пропустит.
        assertQueryAllowed(
          "SELECT id FROM conversation_highlights WHERE user_id = $1 LIMIT 20",
          [7],
        );
        return { messages: [], highlights: [] };
      },
    },
    config: {}, secrets: {}, health: {}, operations: {}, providers: {},
    llmRouter: {}, stt: {}, integrations: {},
    events: { publish: async () => undefined },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    readiness: async () => true,
  } as never);
  await app.ready();

  const response = await app.inject({
    method: "GET",
    url: "/api/admin/v1/users/7/conversation?limit=20",
    headers: { cookie: "eva_admin=session-1" },
  });
  assert.equal(response.statusCode, 200, response.body);
  // Ровно одна запись: ручная, с идентификатором пользователя. Вторая,
  // автоматическая, перекрывала бы её при чтении журнала.
  assert.equal(audits.length, 1);
  assert.match(JSON.stringify(audits[0]?.params), /user_id/);
  await app.close();
});
