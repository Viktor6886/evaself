import assert from "node:assert/strict";
import test from "node:test";

import { configureNocoDB } from "./init-eva.mjs";

const ENV = {
  NC_ADMIN_EMAIL: "admin@example.test",
  NC_ADMIN_PASSWORD: "nocodb-admin-secret",
  EVA_PG_HOST: "postgres",
  EVA_PG_PORT: "5432",
  EVA_PG_DATABASE: "eva",
  EVA_PG_USER: "eva",
  EVA_PG_PASSWORD: "postgres-secret",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jobCompleted(id) {
  return [
    {
      _mid: 1,
      status: "update",
      data: { id, status: "completed", data: { result: true } },
    },
  ];
}

test("создаёт внешнюю базу, синхронизирует таблицы и не пишет секреты", async () => {
  const calls = [];
  const output = [];
  const source = {
    id: "src-eva",
    alias: "Eva PostgreSQL",
    type: "pg",
    is_meta: false,
  };

  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    const pathName = parsedUrl.pathname + parsedUrl.search;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({
      path: pathName,
      method: options.method,
      body,
      headers: options.headers,
    });

    if (pathName === "/api/v1/health") return json({ msg: "OK" });
    if (pathName === "/api/v1/auth/user/signin") return json({ token: "session" });
    if (pathName === "/api/v2/meta/bases/" && options.method === "GET") {
      return json({ list: [] });
    }
    if (pathName === "/api/v2/meta/bases" && options.method === "POST") {
      return json({ id: "base-eva" });
    }
    if (pathName === "/api/v2/meta/bases/base-eva") {
      return json({ id: "base-eva", sources: [source] });
    }
    if (
      pathName === "/api/v2/meta/bases/base-eva/meta-diff/src-eva" &&
      options.method === "POST"
    ) {
      return json({ id: "sync-job" });
    }
    if (pathName === "/jobs/listen") return json(jobCompleted("sync-job"));
    if (pathName === "/api/v2/meta/bases/base-eva/tables?limit=1000") {
      return json({
        list: [
          { id: "table-1", source_id: "src-eva" },
          { id: "table-2", source_id: "src-eva" },
        ],
      });
    }
    throw new Error(`неожиданный запрос ${options.method} ${pathName}`);
  };

  const result = await configureNocoDB({
    env: ENV,
    fetchImpl,
    log: (line) => output.push(line),
  });

  assert.equal(result.baseCreated, true);
  assert.equal(result.sourceCreated, false);
  assert.equal(result.tableCount, 2);

  const create = calls.find(
    (call) =>
      call.path === "/api/v2/meta/bases" && call.method === "POST",
  );
  assert.equal(create.body.external, true);
  assert.equal(create.body.sources[0].config.connection.host, "postgres");
  assert.equal(create.body.sources[0].is_schema_readonly, true);
  assert.equal(create.body.sources[0].is_data_readonly, false);
  assert.ok(calls.every((call) => call.headers["xc-auth"] !== "postgres-secret"));

  const printed = output.join("\n");
  assert.doesNotMatch(printed, /nocodb-admin-secret|postgres-secret|session/);
});

test("повторный запуск не создаёт базу или источник заново", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    const pathName = parsedUrl.pathname + parsedUrl.search;
    calls.push(`${options.method} ${pathName}`);

    if (pathName === "/api/v1/health") return json({ msg: "OK" });
    if (pathName === "/api/v1/auth/user/signin") return json({ token: "session" });
    if (pathName === "/api/v2/meta/bases/") {
      return json({ list: [{ id: "base-eva", title: "Evaself" }] });
    }
    if (pathName === "/api/v2/meta/bases/base-eva") {
      return json({
        id: "base-eva",
        sources: [
          {
            id: "src-eva",
            alias: "Eva PostgreSQL",
            type: "pg",
            is_meta: false,
          },
        ],
      });
    }
    if (pathName === "/api/v2/meta/bases/base-eva/meta-diff/src-eva") {
      return json({ id: "sync-job" });
    }
    if (pathName === "/jobs/listen") return json(jobCompleted("sync-job"));
    if (pathName === "/api/v2/meta/bases/base-eva/tables?limit=1000") {
      return json({ list: [{ id: "table-1", source_id: "src-eva" }] });
    }
    throw new Error(`неожиданный запрос ${options.method} ${pathName}`);
  };

  const result = await configureNocoDB({
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.baseCreated, false);
  assert.equal(result.sourceCreated, false);
  assert.equal(
    calls.filter((call) => call === "POST /api/v2/meta/bases").length,
    0,
  );
  assert.equal(calls.filter((call) => call.endsWith("/sources")).length, 0);
});

test("добавляет отсутствующий источник в уже созданную базу", async () => {
  let baseReads = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsedUrl = new URL(url);
    const pathName = parsedUrl.pathname + parsedUrl.search;
    calls.push(`${options.method} ${pathName}`);

    if (pathName === "/api/v1/health") return json({ msg: "OK" });
    if (pathName === "/api/v1/auth/user/signin") return json({ token: "session" });
    if (pathName === "/api/v2/meta/bases/") {
      return json({ list: [{ id: "base-eva", title: "Evaself" }] });
    }
    if (pathName === "/api/v2/meta/bases/base-eva") {
      baseReads += 1;
      return json({
        id: "base-eva",
        sources:
          baseReads === 1
            ? []
            : [
                {
                  id: "src-eva",
                  alias: "Eva PostgreSQL",
                  type: "pg",
                  is_meta: false,
                },
              ],
      });
    }
    if (
      pathName === "/api/v2/meta/bases/base-eva/sources" &&
      options.method === "POST"
    ) {
      return json({ id: "source-job" });
    }
    if (pathName === "/api/v2/meta/bases/base-eva/meta-diff/src-eva") {
      return json({ id: "sync-job" });
    }
    if (pathName === "/jobs/listen") {
      const body = JSON.parse(options.body);
      return json(jobCompleted(body.data.id));
    }
    if (pathName === "/api/v2/meta/bases/base-eva/tables?limit=1000") {
      return json({ list: [] });
    }
    throw new Error(`неожиданный запрос ${options.method} ${pathName}`);
  };

  const result = await configureNocoDB({
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.baseCreated, false);
  assert.equal(result.sourceCreated, true);
  assert.ok(calls.includes("POST /api/v2/meta/bases/base-eva/sources"));
});
