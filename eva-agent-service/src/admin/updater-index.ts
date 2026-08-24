import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, chown, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { globalSecretRedactor } from "./redactor.js";

const execFileAsync = promisify(execFile);
const dockerSocket = process.env.DOCKER_HOST_SOCKET ?? "/var/run/docker.sock";
const updaterSocket =
  process.env.EVA_UPDATER_SOCKET ?? "/run/evaself-updater/updater.sock";
const projectDir = process.env.EVA_UPDATER_PROJECT_DIR ?? "/workspace";
const updaterSocketGroup =
  process.env.EVA_UPDATER_SOCKET_GROUP ?? "evaself-updater";
const backupDir = process.env.BACKUP_DIR ?? "/var/backups/evaself";
const dockerApi = "/v1.41";

/**
 * GID выделенной группы сокета по имени, из /etc/group.
 *
 * Node не даёт getgrnam, а тянуть зависимость ради одной строки не стоит.
 * Возвращает null, если группы нет.
 */
async function resolveGroupId(name: string): Promise<number | null> {
  let content: string;
  try {
    content = await readFile("/etc/group", "utf8");
  } catch {
    return null;
  }
  for (const line of content.split("\n")) {
    const fields = line.split(":");
    if (fields[0] !== name) continue;
    const gid = Number.parseInt(fields[2] ?? "", 10);
    return Number.isInteger(gid) ? gid : null;
  }
  return null;
}

/**
 * Права на Unix-сокет updater.
 *
 * Сокет открывает путь к фиксированным backup/update-командам, а у самого
 * eva-updater смонтирован Docker socket. Права 0666 давали доступ любому
 * процессу в любом контейнере, который монтирует этот volume. Теперь 0660
 * и владелец root:evaself-updater — группа заведена в образе, и в неё
 * входит пользователь node, под которым работают admin-api и
 * health-worker.
 *
 * Если группы нет, сокет остаётся недоступен клиентам, и молча работать
 * дальше нельзя: это тихо сломало бы обновления. Поэтому — ошибка.
 */
async function secureUpdaterSocket(): Promise<void> {
  const gid = await resolveGroupId(updaterSocketGroup);
  if (gid === null) {
    throw new Error(
      `группа ${updaterSocketGroup} отсутствует в образе: сокет updater нельзя закрыть до 0660, не потеряв admin-api и health-worker`,
    );
  }
  await chown(updaterSocket, 0, gid);
  await chmod(updaterSocket, 0o660);
}

const CONTAINERS = new Map<string, string>([
  ["agent-runtime", "evaself-eva-agent-service"],
  ["app-server", "evaself-letta-app-server"],
  ["admin-api", "evaself-admin-api"],
  ["admin-ui", "evaself-admin-ui"],
  ["postgres", "evaself-postgres"],
  ["valkey", "evaself-valkey"],
  ["media-service", "evaself-media-service"],
  ["searxng", "evaself-searxng"],
  ["crawl4ai", "evaself-crawl4ai"],
  ["caddy", "evaself-caddy"],
  ["webapp", "evaself-webapp"],
  ["letta-ui", "evaself-letta-ui"],
  ["backup-service", "evaself-backup-service"],
  ["monitoring", "evaself-uptime-kuma"],
]);

interface RequestMessage {
  id?: unknown;
  command?: unknown;
  params?: unknown;
}

function dockerRequest<T>(
  method: string,
  requestPath: string,
  expected: number[],
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: dockerSocket,
      path: requestPath,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        if (!expected.includes(response.statusCode ?? 0)) {
          reject(new Error(`Docker API вернул HTTP ${response.statusCode}`));
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          resolve({} as T);
          return;
        }
        try {
          resolve(JSON.parse(raw) as T);
        } catch {
          reject(new Error("Docker API вернул некорректный JSON"));
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("Docker API timeout")));
    request.end(payload);
  });
}

function containerName(target: unknown): string {
  const id = String(target ?? "");
  const name = CONTAINERS.get(id);
  if (!name) throw new Error("Сервис отсутствует в списке разрешённых");
  return name;
}

async function serviceStatus(service: unknown) {
  const name = containerName(service);
  try {
    const data = await dockerRequest<{
      Name?: string;
      State?: {
        Status?: string;
        Running?: boolean;
        StartedAt?: string;
        Health?: { Status?: string };
      };
      RestartCount?: number;
    }>("GET", `${dockerApi}/containers/${encodeURIComponent(name)}/json`, [200]);
    return {
      exists: true,
      running: data.State?.Running === true,
      state: data.State?.Status ?? "unknown",
      health: data.State?.Health?.Status ?? null,
      started_at: data.State?.StartedAt ?? null,
      restart_count: data.RestartCount ?? 0,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("HTTP 404")) {
      return { exists: false, running: false, state: "missing", health: null };
    }
    throw error;
  }
}

/**
 * Поднять сервис. 304 означает «уже запущен» — это не ошибка, а ответ на
 * повторное нажатие. 404 отдаётся как понятное сообщение: контейнера нет,
 * и его создаёт compose, а не Docker API.
 */
async function startService(service: unknown) {
  const name = containerName(service);
  try {
    await dockerRequest("POST", `${dockerApi}/containers/${encodeURIComponent(name)}/start`, [204, 304]);
  } catch (error) {
    if (error instanceof Error && error.message.includes("HTTP 404")) {
      throw new Error(
        `Контейнер ${name} не создан. Выполните на сервере: docker compose up -d ${String(service)}`,
      );
    }
    throw error;
  }
  return await serviceStatus(service);
}

/**
 * Остановить сервис. Останавливать сам admin-api запрещено: он исполняет
 * эту же операцию и не смог бы сообщить о результате, а поднять его
 * обратно из панели было бы уже некому.
 */
async function stopService(service: unknown) {
  const serviceId = String(service ?? "");
  if (serviceId === "admin-api") {
    throw new Error("Административный API нельзя остановить из панели");
  }
  const name = containerName(service);
  await dockerRequest("POST", `${dockerApi}/containers/${encodeURIComponent(name)}/stop?t=30`, [204, 304]);
  return await serviceStatus(service);
}

async function restartService(service: unknown) {
  const serviceId = String(service ?? "");
  const name = containerName(service);
  if (serviceId === "admin-api") {
    setTimeout(() => {
      void dockerRequest(
        "POST",
        `${dockerApi}/containers/${encodeURIComponent(name)}/restart?t=30`,
        [204],
      ).catch(() => {});
    }, 1_500);
    return { exists: true, running: true, state: "restart-scheduled", health: null };
  }
  await dockerRequest(
    "POST",
    `${dockerApi}/containers/${encodeURIComponent(name)}/restart?t=30`,
    [204],
  );
  return await serviceStatus(service);
}

async function serviceLogs(service: unknown, rawTail: unknown) {
  const name = containerName(service);
  const tail = Math.min(500, Math.max(1, Number(rawTail) || 100));
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const request = http.request({
      socketPath: dockerSocket,
      path: `${dockerApi}/containers/${encodeURIComponent(name)}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
      method: "GET",
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 512 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Docker API вернул HTTP ${response.statusCode}`));
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
  // Docker multiplexes stdout/stderr with an 8-byte header. Removing all
  // control bytes produces a readable tail without exposing request input.
  // Stripping control characters is exactly the intent here.
  // eslint-disable-next-line no-control-regex
  const text = raw.toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return {
    lines: String(globalSecretRedactor.redact(text))
      .split("\n")
      .filter(Boolean)
      .slice(-tail),
  };
}

/**
 * Пароль шифрования архива backup.
 *
 * Пишется отдельным файлом, а не в Secret Store: backup.sh — bash-скрипт
 * и расшифровать хранилище не может. Пустое значение удаляет файл, и
 * архивы снова шифруются мастер-ключом.
 *
 * Путь тот же, что читает backup_pass_source в scripts/lib.sh: репозиторий
 * примонтирован сюда по projectDir, и скрипты запускаются оттуда же.
 *
 * Значение сюда приходит от admin-api и дальше никуда не уходит: ни в
 * ответ, ни в журнал.
 */
async function setBackupPassword(value: unknown) {
  const password = typeof value === "string" ? value : "";
  const file = process.env.EVA_BACKUP_PASSWORD_FILE
    ?? path.join(projectDir, "secrets/backup-archive-password");

  if (!password) {
    await rm(file, { force: true });
    return { configured: false };
  }
  if (password.length < 16) {
    throw new Error("пароль архива должен быть не короче 16 символов");
  }
  // openssl -pass file: берёт только первую строку. Хвостовой перевод
  // строки он отбрасывает, так что на ключ тот не влияет, а вот перевод
  // внутри пароля отрезал бы всё после него: архив зашифровался бы
  // огрызком, и восстановление полным паролем не сработало бы.
  if (/[\r\n]/.test(password)) {
    throw new Error("пароль архива не должен содержать перевод строки");
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Пишем ровно значение, без хвостового перевода строки: файл тогда
  // совпадает с паролем побайтово, и его можно сверить глазами.
  await writeFile(file, password, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return { configured: true };
}

async function hostMetrics() {
  const root = await statFsSafe("/");
  return {
    hostname: os.hostname(),
    uptime_seconds: Math.floor(os.uptime()),
    cpu_count: os.cpus().length,
    load_average: os.loadavg(),
    memory_total_bytes: os.totalmem(),
    memory_free_bytes: os.freemem(),
    disk_total_bytes: root.total,
    disk_free_bytes: root.free,
    ...(await networkTotals()),
  };
}

/**
 * Суммарный трафик всех интерфейсов кроме loopback, из /proc/net/dev.
 * Это счётчики с момента загрузки, а не скорость: панель показывает
 * порядок величины, а не мгновенный поток. Если файла нет (не Linux),
 * поля просто отсутствуют, и бар рисует прочерк.
 */
async function networkTotals(): Promise<Record<string, number>> {
  try {
    const raw = await readFile("/proc/net/dev", "utf8");
    let rx = 0;
    let tx = 0;
    // Первые две строки — заголовки таблицы.
    for (const line of raw.split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!name || !rest) continue;
      if (name.trim() === "lo") continue;
      const fields = rest.trim().split(/\s+/);
      rx += Number(fields[0] ?? 0);
      tx += Number(fields[8] ?? 0);
    }
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) return {};
    return { network_rx_bytes: rx, network_tx_bytes: tx };
  } catch {
    return {};
  }
}

async function statFsSafe(target: string): Promise<{ total: number; free: number }> {
  const fs = await import("node:fs");
  const result = fs.statfsSync(target);
  return {
    total: Number(result.blocks) * Number(result.bsize),
    free: Number(result.bavail) * Number(result.bsize),
  };
}

async function listBackups() {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const names = (await readdir(backupDir))
    .filter((name) => /^evaself-backup-[A-Za-z0-9_.-]+\.(?:tar\.gz|enc)$/.test(name));
  const items = await Promise.all(names.map(async (name) => {
    const info = await stat(path.join(backupDir, name));
    return {
      archive_id: name,
      size: info.size,
      created_at: info.mtime.toISOString(),
      encrypted: name.endsWith(".enc"),
    };
  }));
  return items.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

async function runFixedScript(name: "backup.sh" | "update.sh", args: string[] = []) {
  const script = path.join(projectDir, "scripts", name);
  const temporaryRoot = path.join(backupDir, ".updater-tmp");
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const { stdout } = await execFileAsync(script, args, {
    cwd: projectDir,
    timeout: name === "update.sh" ? 30 * 60_000 : 15 * 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      TERM: "dumb",
      EVA_UPDATER_INVOCATION: "1",
      EVA_SECRETS_MASTER_KEY_FILE:
        process.env.EVA_SECRETS_MASTER_KEY_FILE ??
        "/run/secrets/eva-secrets-master-key",
      EVA_BACKUP_MASTER_KEY_FILE: "/run/secrets/eva-secrets-master-key",
      TMPDIR: temporaryRoot,
    },
  });
  return { completed: true, output: globalSecretRedactor.redact(stdout).slice(-4000) };
}

async function updateInfo() {
  const git = async (...args: string[]) => (
    await execFileAsync("git", ["-C", projectDir, ...args], {
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    })
  ).stdout.trim();
  let commit = "unknown";
  let branch = "unknown";
  let dirty = false;
  try {
    [commit, branch] = await Promise.all([
      git("rev-parse", "HEAD"),
      git("rev-parse", "--abbrev-ref", "HEAD"),
    ]);
    dirty = Boolean(await git("status", "--porcelain"));
  } catch {
    // A packaged installation can legitimately be outside a Git checkout.
  }
  return { commit, branch, dirty };
}

async function recreateContainer(currentName: string, removeDelayMs: number) {
  const current = await dockerRequest<{
    Id: string;
    Config: {
      Image: string;
      Env?: string[];
      Cmd?: string[];
      Entrypoint?: string[];
      WorkingDir?: string;
      Labels?: Record<string, string>;
      Healthcheck?: Record<string, unknown>;
      User?: string;
    };
    HostConfig: {
      Binds?: string[];
      RestartPolicy?: Record<string, unknown>;
      NetworkMode?: string;
      LogConfig?: Record<string, unknown>;
    };
  }>("GET", `${dockerApi}/containers/${currentName}/json`, [200]);
  const oldName = `${currentName}-old-${randomUUID().slice(0, 8)}`;
  await dockerRequest(
    "POST",
    `${dockerApi}/containers/${currentName}/rename?name=${encodeURIComponent(oldName)}`,
    [204],
  );
  let created: { Id: string };
  try {
    created = await dockerRequest<{ Id: string }>(
      "POST",
      `${dockerApi}/containers/create?name=${encodeURIComponent(currentName)}`,
      [201],
      {
        Image: current.Config.Image,
        Env: current.Config.Env,
        Cmd: current.Config.Cmd,
        Entrypoint: current.Config.Entrypoint,
        WorkingDir: current.Config.WorkingDir,
        Labels: current.Config.Labels,
        Healthcheck: current.Config.Healthcheck,
        User: current.Config.User,
        HostConfig: {
          Binds: current.HostConfig.Binds,
          RestartPolicy: current.HostConfig.RestartPolicy,
          NetworkMode: current.HostConfig.NetworkMode,
          LogConfig: current.HostConfig.LogConfig,
        },
      },
    );
    await dockerRequest(
      "POST",
      `${dockerApi}/containers/${encodeURIComponent(created.Id)}/start`,
      [204],
    );
  } catch (error) {
    await dockerRequest(
      "POST",
      `${dockerApi}/containers/${encodeURIComponent(oldName)}/rename?name=${currentName}`,
      [204],
    ).catch(() => {});
    throw error;
  }
  setTimeout(() => {
    void dockerRequest(
      "DELETE",
      `${dockerApi}/containers/${encodeURIComponent(current.Id)}?force=1&v=1`,
      [204],
    ).catch(() => {});
  }, removeDelayMs);
  return { recreated: true, replacement_id: created.Id };
}

async function handoffUpdate() {
  setTimeout(() => {
    void (async () => {
      await recreateContainer("evaself-admin-api", 3_000);
      await recreateContainer("evaself-eva-updater", 1_500);
    })().catch(() => {});
  }, 750);
  return { scheduled: true };
}

async function dispatch(command: string, params: Record<string, unknown>) {
  switch (command) {
    case "get_service_status":
      return await serviceStatus(params.service);
    case "start_service":
      return await startService(params.service);
    case "stop_service":
      return await stopService(params.service);
    case "restart_service":
      return await restartService(params.service);
    case "get_service_logs":
      return await serviceLogs(params.service, params.tail);
    case "set_backup_password":
      return await setBackupPassword(params.password);
    case "host_metrics":
      return await hostMetrics();
    case "list_backups":
      return await listBackups();
    case "create_backup":
      return await runFixedScript("backup.sh");
    case "get_update_info":
      return await updateInfo();
    case "check_update":
      return await runFixedScript("update.sh", ["--preview"]);
    case "pull_and_up":
      return await runFixedScript("update.sh");
    case "handoff_update":
      return await handoffUpdate();
    default:
      throw new Error("Команда отсутствует в разрешённом контракте");
  }
}

async function main() {
  await mkdir(path.dirname(updaterSocket), { recursive: true, mode: 0o755 });
  await rm(updaterSocket, { force: true });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      // setEncoding above means this is already a string at runtime; the
      // node typings still say Buffer.
      buffer += String(chunk);
      if (buffer.length > 64 * 1024) socket.destroy();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      buffer = "";
      void (async () => {
        const request = JSON.parse(raw) as RequestMessage;
        const id = typeof request.id === "string" ? request.id : randomUUID();
        const command = typeof request.command === "string" ? request.command : "";
        const params = request.params && typeof request.params === "object" &&
          !Array.isArray(request.params)
          ? request.params as Record<string, unknown>
          : {};
        try {
          const result = await dispatch(command, params);
          socket.end(`${JSON.stringify({ id, ok: true, result })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({
            id,
            ok: false,
            error: {
              code: "operation_failed",
              message: error instanceof Error ? error.message : "Операция не выполнена",
            },
          })}\n`);
        }
      })().catch(() => socket.destroy());
    });
  });
  server.listen(updaterSocket, () => {
    // The listen callback is void-returning: an async body would drop a
    // rejected chmod on the floor as an unhandled rejection.
    void (async () => {
      await secureUpdaterSocket();
      process.stdout.write(`${JSON.stringify({
        level: "info",
        service: "eva-updater",
        message: "Unix socket готов",
        socket: updaterSocket,
        socket_mode: "0660",
        socket_group: updaterSocketGroup,
        command_count: 10,
      })}\n`);
    })().catch((error) => {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        service: "eva-updater",
        message: "Не удалось подготовить Unix socket",
        code: error instanceof Error ? error.name : "unknown",
      })}\n`);
      process.exit(1);
    });
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    level: "error",
    service: "eva-updater",
    message: "Не удалось запустить updater",
    code: error instanceof Error ? error.name : "unknown",
  })}\n`);
  process.exit(1);
});
