/**
 * Через какой сервер Bot API работает бот: облако Telegram или свой.
 *
 * Облачный Bot API отдаёт боту файлы только до 20 МБ; свой сервер в
 * локальном режиме — любые (docs/telegram-bot-api.md). Переключение
 * раньше делалось только скриптом на сервере; здесь то же самое — из
 * раздела «Распознавание речи».
 *
 * Проверка эквивалента (правило 20). Ключи приложения my.telegram.org
 * хранит существующая форма интеграции Telegram (IntegrationConfigService:
 * `system_settings` и Secret Store) — второго хранилища нет. Переезд на
 * другого бота (TelegramTokenService) меняет, КАКИМ ботом быть, а здесь
 * меняется, ЧЕРЕЗ ЧТО он говорит с Telegram. Саму работу — `.env`,
 * профиль compose, пересоздание сервисов — делает тот же скрипт, что и
 * руками (`scripts/telegram-local-bot-api.sh`), через сервис операций.
 * Нового здесь только выход бота из облака: у сервиса операций нет ни
 * curl, ни выхода к Telegram.
 */

import type pg from "pg";

import { adminBadRequest, AdminApiError } from "./errors.js";
import { TELEGRAM_API_HASH_SECRET, TELEGRAM_API_ID_SETTING } from "./integration-config-service.js";
import { globalSecretRedactor } from "./redactor.js";
import type { SecretStore } from "./secret-store.js";
import type { UpdaterClient } from "./updater-client.js";

export const CLOUD_BOT_API = "https://api.telegram.org";

const BOT_TOKEN_SECRET = "sec_eva_telegram_bot_token";

/** Сервер собирается поверх официального образа и поднимает три сервиса. */
const SWITCH_TIMEOUT_MS = 10 * 60_000;

export type BotApiMode = "cloud" | "local";

export interface BotApiModeStatus {
  mode: BotApiMode;
  base_url: string;
  /** Предел облака известен; свой сервер ограничивает агент (EVA_AUDIO_FILE_MAX_MB). */
  cloud_file_limit_mb: 20;
  credentials: { api_id: string | null; api_hash_configured: boolean };
  bot_token_configured: boolean;
  /** Контейнер своего сервера; null — сервис операций не ответил. */
  server: { exists: boolean; running: boolean; health: string | null } | null;
  server_error: string | null;
}

export interface TelegramBotApiModeOptions {
  pool: Pick<pg.Pool, "query">;
  secrets: Pick<SecretStore, "get" | "list">;
  updater: Pick<UpdaterClient, "call">;
  /** Адрес Bot API, с которым admin-api создан: после переключения его пересоздают. */
  baseUrl: string;
  fetcher?: typeof fetch;
  logger: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

export function modeOf(baseUrl: string): BotApiMode {
  return baseUrl.replace(/\/+$/u, "") === CLOUD_BOT_API ? "cloud" : "local";
}

export class TelegramBotApiModeService {
  constructor(private readonly options: TelegramBotApiModeOptions) {}

  async status(): Promise<BotApiModeStatus> {
    const [apiId, secrets] = await Promise.all([this.apiId(), this.options.secrets.list()]);
    const configured = new Set(secrets.filter((item) => item.configured).map((item) => item.secret_ref));
    let server: BotApiModeStatus["server"] = null;
    let serverError: string | null = null;
    try {
      const container = await this.options.updater.call<{ exists?: boolean; running?: boolean; health?: string | null }>(
        "get_service_status",
        { service: "telegram-bot-api" },
      );
      server = {
        exists: container.exists === true,
        running: container.running === true,
        health: container.health ?? null,
      };
    } catch (error) {
      serverError = error instanceof Error ? error.message : "сервис операций недоступен";
    }
    return {
      mode: modeOf(this.options.baseUrl),
      base_url: this.options.baseUrl,
      cloud_file_limit_mb: 20,
      credentials: { api_id: apiId, api_hash_configured: configured.has(TELEGRAM_API_HASH_SECRET) },
      bot_token_configured: configured.has(BOT_TOKEN_SECRET),
      server,
      server_error: serverError,
    };
  }

  /**
   * Переключить сервер Bot API.
   *
   * Переезд — три шага в таком порядке, чтобы отказ на любом не оставил
   * бота без связи:
   *  1. свой сервер поднимается с ключами и принимает бота (`getMe`) —
   *     бот ещё в облаке и отвечает, а заодно проверено, что сервис
   *     операций жив;
   *  2. бот выходит из облака (`logOut`);
   *  3. режим попадает в `.env`, клиенты пересоздаются.
   *
   * «local» при уже своём сервере — не ошибка: так применяются новые
   * ключи, и выход из облака тогда не повторяется. После ответа admin-api
   * пересоздаётся — панель на несколько секунд потеряет связь.
   */
  async switchMode(input: unknown): Promise<{ mode: BotApiMode; admin_restart_scheduled: boolean }> {
    if (input !== "local" && input !== "cloud") throw adminBadRequest("Режим — local или cloud");
    const mode: BotApiMode = input;

    if (mode === "cloud") {
      await this.updaterStep({ mode }, "Возврат в облако не завершён");
      this.options.logger.info("Telegram: бот возвращён в облачный Bot API");
      return { mode, admin_restart_scheduled: true };
    }

    const apiId = await this.apiId();
    const apiHash = await this.options.secrets.get(TELEGRAM_API_HASH_SECRET);
    if (!apiId || !apiHash) {
      throw adminBadRequest("Сначала сохраните API ID и API Hash с my.telegram.org");
    }
    const token = await this.options.secrets.get(BOT_TOKEN_SECRET);
    if (!token) throw adminBadRequest("Токен бота не задан: без него бота не перевести");
    const fromCloud = modeOf(this.options.baseUrl) === "cloud";

    await this.updaterStep(
      { mode, stage: "prepare", api_id: apiId, api_hash: apiHash },
      fromCloud
        ? "Свой сервер Bot API не поднялся — бот остался в облаке, ничего не переключено"
        : "Свой сервер Bot API не принял новые ключи — возвращены прежние",
    );
    if (fromCloud) await this.logOutFromCloud(token);
    await this.updaterStep(
      { mode, stage: "apply" },
      fromCloud
        ? "Бот вышел из облака, но переключение не завершено — свой сервер уже поднят, повторите переход"
        : "Переключение не завершено",
    );
    this.options.logger.info("Telegram: бот работает через свой сервер Bot API");
    return { mode, admin_restart_scheduled: true };
  }

  private async updaterStep(params: Record<string, unknown>, failure: string): Promise<void> {
    try {
      await this.options.updater.call("switch_telegram_bot_api", params, SWITCH_TIMEOUT_MS);
    } catch (error) {
      // Сообщение сервиса операций — это вывод скрипта: в нём причина, но
      // ключи туда попасть не должны. Их значения редактор уже знает —
      // Secret Store регистрирует каждое открытое значение.
      const message = error instanceof Error ? error.message : "Операция не выполнена";
      throw new AdminApiError(
        "telegram_bot_api_switch_failed",
        `${failure}: ${globalSecretRedactor.redactText(message).slice(0, 600)}`,
        502,
      );
    }
  }

  /**
   * Вывести бота из облачного Bot API.
   *
   * Без этого Telegram не гарантирует, что обновления пойдут на свой
   * сервер. Отказ облака — не препятствие: повторный вызов отвечает
   * ошибкой, потому что бот уже вышел. А вот отсутствие ответа —
   * препятствие: неизвестно, вышел ли бот, и начинать переезд вслепую
   * нельзя.
   */
  private async logOutFromCloud(token: string): Promise<void> {
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(`${CLOUD_BOT_API}/bot${token}/logOut`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw adminBadRequest(
        "Облачный Bot API не ответил на выход бота (logOut). Без него Telegram не гарантирует "
        + "доставку сообщений на свой сервер, поэтому бот остался в облаке — повторите позже.",
      );
    }
    const body = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (body?.ok) {
      this.options.logger.info("Telegram: бот вышел из облачного Bot API");
    } else {
      // Токена в журнале нет: только код ответа.
      this.options.logger.warn("Telegram: облако отказало в logOut — бот, вероятно, уже вышел", {
        status: response.status,
      });
    }
  }

  private async apiId(): Promise<string | null> {
    const { rows } = await this.options.pool.query<{ value_json: unknown }>(
      "SELECT value_json FROM system_settings WHERE key = $1",
      [TELEGRAM_API_ID_SETTING],
    );
    const raw = rows[0]?.value_json;
    const value = raw == null ? "" : String(raw).trim();
    return value || null;
  }
}
