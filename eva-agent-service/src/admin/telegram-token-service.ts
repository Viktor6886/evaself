/**
 * Боты Евы: набор токенов и переключение между ними.
 *
 * Токен Telegram — не взаимозаменяемый ключ, а личность бота. У каждого
 * свой `@username`, свои диалоги и свой вебхук, поэтому «сменить токен»
 * означает «стать другим ботом», и относиться к этому нужно как к
 * переезду, а не как к ротации.
 *
 * Активный токен остаётся в `secret_records` под прежним
 * `sec_eva_telegram_bot_token`: его читают service-catalog, bootstrap и
 * форма интеграций, и ни одно из этих мест менять не пришлось. Здесь
 * лежит набор, из которого активный выбирают.
 *
 * Сам токен наружу не выходит никогда. Панель показывает метку и
 * `@username` — их достаточно, чтобы человек узнал своего бота, и они не
 * являются секретом.
 */

import type pg from "pg";

import { adminBadRequest, adminNotFound } from "./errors.js";
import type { SecretStore } from "./secret-store.js";

/** Больше пяти ботов у одной установки — это уже не переезд, а свалка. */
const MAX_TOKENS = 5;

const TOKEN_SECRET_REF = "sec_eva_telegram_bot_token";

export interface TelegramBotTokenView {
  id: string;
  label: string;
  bot_username: string;
  is_active: boolean;
  created_at: string;
  activated_at: string | null;
}

/** Что умеет Bot API применительно к чужому токену. */
export interface TelegramBotApi {
  /** Проверяет токен и возвращает, каким ботом он является. */
  identify(token: string): Promise<{ id: number; username: string }>;
  /** Ставит вебхук новому боту. */
  setWebhook(token: string, url: string, secret: string): Promise<void>;
  /** Снимает вебхук у прежнего: иначе он продолжит получать обновления. */
  deleteWebhook(token: string): Promise<void>;
}

export interface TelegramTokenServiceOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  api: TelegramBotApi;
  /** Адрес, на который Telegram шлёт обновления. */
  webhookUrl: string;
  /** Заголовок, которым webhook отличает Telegram от постороннего. */
  webhookSecret: string;
  logger: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void };
}

export class TelegramTokenService {
  constructor(private readonly options: TelegramTokenServiceOptions) {}

  async list(): Promise<{ tokens: TelegramBotTokenView[]; limit: number }> {
    const { rows } = await this.options.pool.query<Record<string, unknown>>(
      `SELECT id, label, bot_username, is_active, created_at, activated_at
         FROM telegram_bot_tokens
        ORDER BY is_active DESC, created_at`,
    );
    return { tokens: rows.map(toView), limit: MAX_TOKENS };
  }

  /**
   * Добавляет токен, предварительно спросив у Telegram, чей он.
   *
   * Проверка не формальность: она отсеивает опечатку до того, как токен
   * ляжет в базу, и даёт `@username` — единственное, по чему человек
   * потом отличит одного своего бота от другого, не видя самих токенов.
   */
  async add(input: { token: unknown; label: unknown }, actorId: string | null): Promise<TelegramBotTokenView> {
    const token = String(input.token ?? "").trim();
    if (!token) throw adminBadRequest("Токен не может быть пустым");
    const label = String(input.label ?? "").trim();
    if (!label) throw adminBadRequest("Дайте боту метку — по ней вы отличите его от остальных");

    const { rows: countRows } = await this.options.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM telegram_bot_tokens",
    );
    if (Number(countRows[0]?.count ?? 0) >= MAX_TOKENS) {
      throw adminBadRequest(
        `Сохранено уже ${MAX_TOKENS} токенов — это предел. Удалите ненужный и добавьте заново.`,
      );
    }

    const bot = await this.identify(token);
    const envelope = this.options.secrets.seal(token);
    try {
      const { rows } = await this.options.pool.query<Record<string, unknown>>(
        `INSERT INTO telegram_bot_tokens
           (label, bot_id, bot_username, ciphertext, nonce, auth_tag, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, label, bot_username, is_active, created_at, activated_at`,
        [label, bot.id, bot.username, envelope.ciphertext, envelope.nonce, envelope.authTag, actorId],
      );
      return toView(rows[0]!);
    } catch (error) {
      // Тот же бот уже заведён: две записи на него означали бы два
      // разных мнения о том, каким токеном к нему обращаться.
      if ((error as { code?: string } | null)?.code === "23505") {
        throw adminBadRequest(`Бот @${bot.username} уже сохранён. Удалите прежнюю запись, если токен сменился.`);
      }
      throw error;
    }
  }

  /**
   * Делает бота активным.
   *
   * Порядок шагов выбран так, чтобы ни один отказ не оставил установку
   * между двумя ботами:
   *
   *  1. вебхук ставится новому боту — если Telegram откажет, ничего ещё
   *     не изменилось и Ева продолжает работать прежним;
   *  2. токен переносится в secret_records — с этого момента новый бот
   *     станет активным после перезапуска сервиса;
   *  3. пометка в таблице;
   *  4. вебхук снимается у прежнего — уже неважно, удастся ли: он
   *     всё равно больше не наш, и его неудача не повод откатывать
   *     переезд.
   */
  async activate(id: string, actorId: string | null): Promise<{ token: TelegramBotTokenView; restart_required: string }> {
    const row = await this.row(id);
    if (row.is_active === true) {
      return { token: toView(row), restart_required: "eva-agent-service" };
    }
    const token = this.options.secrets.open({
      ciphertext: row.ciphertext as Buffer,
      nonce: row.nonce as Buffer,
      authTag: row.auth_tag as Buffer,
    });

    await this.options.api.setWebhook(token, this.options.webhookUrl, this.options.webhookSecret);
    await this.options.secrets.put(TOKEN_SECRET_REF, token, ["telegram-runtime"], actorId);

    const previous = await this.options.pool.query<Record<string, unknown>>(
      "SELECT ciphertext, nonce, auth_tag, bot_username FROM telegram_bot_tokens WHERE is_active",
    );
    await this.options.pool.query("UPDATE telegram_bot_tokens SET is_active = false WHERE is_active");
    const { rows } = await this.options.pool.query<Record<string, unknown>>(
      `UPDATE telegram_bot_tokens
          SET is_active = true, activated_at = now()
        WHERE id = $1
      RETURNING id, label, bot_username, is_active, created_at, activated_at`,
      [id],
    );

    const old = previous.rows[0];
    if (old) {
      try {
        await this.options.api.deleteWebhook(this.options.secrets.open({
          ciphertext: old.ciphertext as Buffer,
          nonce: old.nonce as Buffer,
          authTag: old.auth_tag as Buffer,
        }));
      } catch (error) {
        // Переезд уже состоялся. Прежний бот просто останется с
        // вебхуком, который ему никто не обслуживает.
        this.options.logger.warn("Не удалось снять webhook у прежнего бота", {
          bot: old.bot_username,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.options.logger.info("Telegram: активирован другой бот", {
      bot: rows[0]?.bot_username,
      // Токена в журнале нет и быть не может.
    });
    return { token: toView(rows[0]!), restart_required: "eva-agent-service" };
  }

  async remove(id: string): Promise<void> {
    const row = await this.row(id);
    if (row.is_active === true) {
      throw adminBadRequest(
        "Нельзя удалить активного бота: сначала сделайте активным другого, иначе Ева останется без токена.",
      );
    }
    await this.options.pool.query("DELETE FROM telegram_bot_tokens WHERE id = $1", [id]);
  }

  private async identify(token: string): Promise<{ id: number; username: string }> {
    try {
      return await this.options.api.identify(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw adminBadRequest(`Telegram не принял токен: ${message}`);
    }
  }

  private async row(id: string): Promise<Record<string, unknown>> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw adminBadRequest("Некорректный идентификатор токена");
    const { rows } = await this.options.pool.query<Record<string, unknown>>(
      "SELECT * FROM telegram_bot_tokens WHERE id = $1",
      [id],
    );
    if (!rows[0]) throw adminNotFound("Такой токен не сохранён");
    return rows[0];
  }
}

function toView(row: Record<string, unknown>): TelegramBotTokenView {
  return {
    id: String(row.id),
    label: String(row.label),
    bot_username: String(row.bot_username),
    is_active: row.is_active === true,
    created_at: new Date(row.created_at as string).toISOString(),
    activated_at: row.activated_at ? new Date(row.activated_at as string).toISOString() : null,
  };
}
