/**
 * Правка `.env` установки сервисом операций.
 *
 * Панель хранит настройки в PostgreSQL, но часть их читают контейнеры,
 * которые PostgreSQL не видят: compose подставляет значения из `.env` при
 * создании контейнера. Правка того же вида, что делает set_env
 * установщика: строка с ключом заменяется целиком, остальные не
 * трогаются, отсутствующий ключ дописывается.
 *
 * Модуль отделён от updater-index: тот при импорте поднимает сокет, а
 * запись `.env` должна проверяться тестом без сокета и без Docker.
 */

import { chmod, readFile, writeFile } from "node:fs/promises";

/** Ключи, которые панель вправе менять в `.env`. Остальные — только установщик. */
const WRITABLE_KEYS = new Set([
  "EVA_TELEGRAM_BOT_TOKEN",
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
]);

export async function setEnvValues(file: string, values: Record<string, string>): Promise<{ replaced: string[] }> {
  for (const [key, value] of Object.entries(values)) {
    if (!WRITABLE_KEYS.has(key)) throw new Error(`ключ ${key} панелью не меняется`);
    // Перевод строки разорвал бы .env на две записи, и вторая половина
    // стала бы мусорной переменной окружения.
    if (/[\r\n]/.test(value)) throw new Error(`значение ${key} не должно содержать перевод строки`);
  }

  let lines: string[];
  try {
    lines = (await readFile(file, "utf8")).split("\n");
  } catch {
    throw new Error(".env не найден: установка не настроена");
  }

  const pending = new Map(Object.entries(values));
  const replaced: string[] = [];
  const out = lines.map((line) => {
    const key = line.split("=", 1)[0]?.trim() ?? "";
    if (!pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    replaced.push(key);
    return `${key}=${value}`;
  });
  if (pending.size) {
    // Пустая последняя строка — обычный хвост файла; дописываем в неё,
    // чтобы не плодить пустых строк при каждой правке.
    if (out.length && out[out.length - 1] === "") out.pop();
    for (const [key, value] of pending) out.push(`${key}=${value}`);
    out.push("");
  }
  await writeFile(file, out.join("\n"), { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return { replaced };
}

/**
 * Ключи приложения my.telegram.org для своего сервера Bot API.
 *
 * Проверяются здесь, а не только в панели: updater — последний, кто
 * видит значение перед `.env`, и мусор в нём всплыл бы лишь отказом
 * сервера Bot API при старте, без объяснения в панели.
 */
export function telegramApiCredentials(params: Record<string, unknown>): { apiId: string; apiHash: string } {
  const apiId = typeof params.api_id === "string" ? params.api_id.trim() : "";
  const apiHash = typeof params.api_hash === "string" ? params.api_hash.trim() : "";
  if (!/^[0-9]{1,12}$/.test(apiId)) throw new Error("API ID — только цифры, до 12");
  if (!/^[0-9a-fA-F]{32}$/.test(apiHash)) throw new Error("API Hash — 32 символа 0–9 и a–f");
  return { apiId, apiHash };
}
