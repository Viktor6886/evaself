import { createHmac, timingSafeEqual } from "node:crypto";

import { unauthorized } from "../errors.js";

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

export interface VerifiedTelegramWebAppData {
  user: TelegramWebAppUser;
  authDate: Date;
  queryId: string | null;
}

export interface TelegramWebAppAuthOptions {
  maxAgeSeconds?: number;
  now?: Date;
  futureSkewSeconds?: number;
}

/**
 * Telegram Mini App validation:
 * secret = HMAC-SHA256("WebAppData", bot token)
 * hash   = HMAC-SHA256(secret, sorted data-check-string)
 *
 * The Telegram user is parsed only after the signature and auth_date have
 * passed validation. Public handlers never trust a user id from JSON bodies.
 */
export function verifyTelegramWebAppInitData(
  initData: string,
  botToken: string,
  options: TelegramWebAppAuthOptions = {},
): VerifiedTelegramWebAppData {
  if (!botToken) throw unauthorized("Telegram Bot Token не настроен");
  if (!initData || initData.length > 16_384) {
    throw unauthorized("X-Telegram-Init-Data отсутствует или слишком велик");
  }

  const params = new URLSearchParams(initData);
  const presentedHash = params.get("hash")?.toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(presentedHash)) {
    throw unauthorized("Подпись Telegram Mini App отсутствует или неверна");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (!constantTimeHexEquals(presentedHash, expectedHash)) {
    throw unauthorized("Подпись Telegram Mini App не прошла проверку");
  }

  const authDateSeconds = Number.parseInt(params.get("auth_date") ?? "", 10);
  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    throw unauthorized("auth_date Telegram Mini App отсутствует");
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const maxAge = Math.max(60, options.maxAgeSeconds ?? 3_600);
  const futureSkew = Math.max(0, options.futureSkewSeconds ?? 30);
  if (authDateSeconds > nowSeconds + futureSkew) {
    throw unauthorized("auth_date Telegram Mini App находится в будущем");
  }
  if (nowSeconds - authDateSeconds > maxAge) {
    throw unauthorized("Сессия Telegram Mini App истекла");
  }

  let rawUser: unknown;
  try {
    rawUser = JSON.parse(params.get("user") ?? "");
  } catch {
    throw unauthorized("Telegram Mini App не передал пользователя");
  }
  const user = normalizeTelegramUser(rawUser);
  return {
    user,
    authDate: new Date(authDateSeconds * 1000),
    queryId: params.get("query_id"),
  };
}

function normalizeTelegramUser(value: unknown): TelegramWebAppUser {
  if (!value || typeof value !== "object") {
    throw unauthorized("Данные пользователя Telegram Mini App неверны");
  }
  const source = value as Record<string, unknown>;
  const id = typeof source.id === "number" ? source.id : Number(source.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw unauthorized("Telegram ID пользователя неверен");
  }
  const firstName = cleanOptional(source.first_name, 256);
  if (!firstName) throw unauthorized("Telegram не передал имя пользователя");
  return {
    id,
    first_name: firstName,
    ...(cleanOptional(source.last_name, 256)
      ? { last_name: cleanOptional(source.last_name, 256)! }
      : {}),
    ...(cleanOptional(source.username, 64)
      ? { username: cleanOptional(source.username, 64)! }
      : {}),
    ...(cleanOptional(source.language_code, 16)
      ? { language_code: cleanOptional(source.language_code, 16)! }
      : {}),
    ...(typeof source.is_premium === "boolean" ? { is_premium: source.is_premium } : {}),
  };
}

function cleanOptional(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean ? clean.slice(0, limit) : null;
}

function constantTimeHexEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
