import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "http://127.0.0.1:8080";
const DEFAULT_BASE_TITLE = "Evaself";
const DEFAULT_SOURCE_ALIAS = "Eva PostgreSQL";

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`не задана обязательная переменная ${name}`);
  }
  return value;
}

function redact(value, secrets) {
  let result = String(value ?? "");
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[скрыто]");
  }
  return result;
}

function responseMessage(body, statusText) {
  if (typeof body === "string") return body;
  return (
    body?.msg ??
    body?.message ??
    body?.error?.message ??
    statusText ??
    "неизвестная ошибка"
  );
}

export function createApi({
  apiUrl = DEFAULT_API_URL,
  fetchImpl = globalThis.fetch,
  secrets = [],
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("текущая версия Node.js не поддерживает fetch");
  }

  return async function request(
    method,
    pathName,
    { body, token, timeoutMs = 35_000 } = {},
  ) {
    let response;
    try {
      response = await fetchImpl(`${apiUrl}${pathName}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { "xc-auth": token } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const safeMessage = redact(error?.message ?? error, secrets);
      throw new Error(`NocoDB API недоступен: ${safeMessage}`, { cause: error });
    }

    const raw = await response.text();
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }

    if (!response.ok) {
      const message = redact(
        responseMessage(parsed, response.statusText),
        secrets,
      );
      const error = new Error(
        `NocoDB API ${method} ${pathName}: HTTP ${response.status}: ${message}`,
      );
      error.status = response.status;
      error.body = parsed;
      throw error;
    }

    return parsed;
  };
}

function listFrom(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.list)) return response.list;
  return [];
}

async function waitForApi(request, attempts = 60) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await request("GET", "/api/v1/health", { timeoutMs: 3_000 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1_000);
    }
  }
  throw lastError;
}

async function signIn(request, email, password, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request("POST", "/api/v1/auth/user/signin", {
        body: { email, password },
        timeoutMs: 10_000,
      });
      if (!response?.token) {
        throw new Error("NocoDB не вернула токен административной сессии");
      }
      return response.token;
    } catch (error) {
      lastError = error;
      if (error.status === 401 || error.status === 403) throw error;
      if (attempt < attempts) await sleep(1_000);
    }
  }
  throw lastError;
}

async function waitForJob(request, token, jobId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let messageId = 0;

  while (Date.now() < deadline) {
    let response;
    try {
      response = await request("POST", "/jobs/listen", {
        body: { _mid: messageId, data: { id: jobId } },
        token,
        timeoutMs: 35_000,
      });
    } catch (error) {
      if (
        error.cause?.name === "TimeoutError" ||
        error.cause?.name === "AbortError"
      ) {
        continue;
      }
      throw error;
    }

    const messages = Array.isArray(response) ? response : [response];
    for (const message of messages) {
      if (Number.isInteger(message?._mid)) {
        messageId = Math.max(messageId, message._mid);
      }
      const status =
        message?.status === "update" ? message?.data?.status : message?.status;
      const data =
        message?.status === "update" ? message?.data?.data : message?.data;

      if (status === "completed") return data?.result;
      if (status === "failed") {
        throw new Error(
          data?.error?.message ??
            data?.message ??
            "задача NocoDB завершилась ошибкой",
        );
      }
    }
  }

  throw new Error(`задача NocoDB ${jobId} не завершилась за ${timeoutMs / 1000} с`);
}

function sourcePayload(env) {
  const port = Number(required(env, "EVA_PG_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("EVA_PG_PORT должен быть корректным TCP-портом");
  }

  return {
    alias: env.NOCODB_EVA_SOURCE_ALIAS?.trim() || DEFAULT_SOURCE_ALIAS,
    type: "pg",
    config: {
      client: "pg",
      connection: {
        host: required(env, "EVA_PG_HOST"),
        port,
        user: required(env, "EVA_PG_USER"),
        password: required(env, "EVA_PG_PASSWORD"),
        database: required(env, "EVA_PG_DATABASE"),
        ssl: false,
      },
      searchPath: ["public"],
    },
    inflection_column: "none",
    inflection_table: "none",
    is_schema_readonly: true,
    is_data_readonly: false,
  };
}

async function getBase(request, token, baseId) {
  return request("GET", `/api/v2/meta/bases/${encodeURIComponent(baseId)}`, {
    token,
  });
}

function findEvaSource(base, alias) {
  return (base?.sources ?? []).find(
    (source) =>
      source?.alias === alias &&
      source?.type === "pg" &&
      source?.is_meta !== true,
  );
}

export async function configureNocoDB({
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const email = required(env, "NC_ADMIN_EMAIL");
  const password = required(env, "NC_ADMIN_PASSWORD");
  const payload = sourcePayload(env);
  const baseTitle = env.NOCODB_EVA_BASE_TITLE?.trim() || DEFAULT_BASE_TITLE;
  const apiUrl = env.NOCODB_INTERNAL_URL?.trim() || DEFAULT_API_URL;
  const secrets = [password, payload.config.connection.password];
  const request = createApi({ apiUrl, fetchImpl, secrets });

  await waitForApi(request);
  const token = await signIn(request, email, password);

  const basesResponse = await request("GET", "/api/v2/meta/bases/", { token });
  let base = listFrom(basesResponse).find((item) => item?.title === baseTitle);
  let baseCreated = false;

  if (!base) {
    base = await request("POST", "/api/v2/meta/bases", {
      token,
      timeoutMs: 180_000,
      body: {
        title: baseTitle,
        description:
          "Таблицы PostgreSQL проекта Evaself. Подключено установщиком автоматически.",
        type: "database",
        external: true,
        config: { client: "pg" },
        sources: [payload],
      },
    });
    baseCreated = true;
  }

  if (!base?.id) {
    throw new Error("NocoDB не вернула ID базы Evaself");
  }

  base = await getBase(request, token, base.id);
  let source = findEvaSource(base, payload.alias);
  let sourceCreated = false;

  if (!source) {
    const job = await request(
      "POST",
      `/api/v2/meta/bases/${encodeURIComponent(base.id)}/sources`,
      { token, body: payload },
    );
    if (!job?.id) throw new Error("NocoDB не вернула ID задачи создания источника");
    await waitForJob(request, token, job.id);
    sourceCreated = true;
    base = await getBase(request, token, base.id);
    source = findEvaSource(base, payload.alias);
  }

  if (!source?.id) {
    throw new Error("источник Eva PostgreSQL не появился в базе NocoDB");
  }

  const syncJob = await request(
    "POST",
    `/api/v2/meta/bases/${encodeURIComponent(base.id)}/meta-diff/${encodeURIComponent(source.id)}`,
    { token },
  );
  if (!syncJob?.id) {
    throw new Error("NocoDB не вернула ID задачи синхронизации метаданных");
  }
  await waitForJob(request, token, syncJob.id);

  const tablesResponse = await request(
    "GET",
    `/api/v2/meta/bases/${encodeURIComponent(base.id)}/tables?limit=1000`,
    { token },
  );
  const tables = listFrom(tablesResponse).filter(
    (table) =>
      !table?.source_id ||
      table.source_id === source.id ||
      table.fk_source_id === source.id,
  );

  if (baseCreated) log(`  ✔ создана база NocoDB «${baseTitle}»`);
  if (sourceCreated) log(`  ✔ подключён источник «${payload.alias}»`);
  log(`  ✔ синхронизировано объектов PostgreSQL: ${tables.length}`);

  return {
    baseId: base.id,
    sourceId: source.id,
    tableCount: tables.length,
    baseCreated,
    sourceCreated,
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  configureNocoDB().catch((error) => {
    const message = redact(error.message, [
      process.env.NC_ADMIN_PASSWORD,
      process.env.EVA_PG_PASSWORD,
    ]);
    console.error(`  ✖ автоматическое подключение NocoDB: ${message}`);
    process.exitCode = 1;
  });
}
