/**
 * Обращения к Bot API от имени чужого токена.
 *
 * Обычный `TelegramClient` — это Ева: он привязан к одному токену, ведёт
 * очередь доставки, лимиты и повторы. Здесь задача противоположная и
 * узкая: спросить у Telegram, чей это токен, и переставить вебхук при
 * переезде на другого бота. Три метода без состояния — не второй клиент,
 * а инструмент управления тем, каким клиент станет.
 */

/*
 * Что Telegram вообще доставляет боту.
 *
 * Список ограничительный: чего в нём нет, того webhook не увидит — молча,
 * без ошибки. Здесь не хватало двух видов, и оба отказывали именно так.
 *
 * `pre_checkout_query` — подтверждение перед списанием звёзд. Без него
 * Telegram не спросит подтверждения, не дождётся ответа и отменит платёж:
 * оплата не работала бы вовсе, а причина не была бы видна нигде.
 *
 * `poll_answer` — голос человека в опросе. Ева умеет их отправлять и
 * разбирать ответы, но после переезда на другого бота ответы переставали
 * приходить.
 */
const ALLOWED_UPDATES = [
  "message",
  "edited_message",
  "callback_query",
  "poll_answer",
  "pre_checkout_query",
] as const;

export interface TelegramBotApiOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export function createTelegramBotApi(options: TelegramBotApiOptions) {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = options.baseUrl.replace(/\/+$/u, "");

  const call = async <T>(token: string, method: string, body: Record<string, unknown>): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetcher(`${base}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Telegram не ответил за ${timeoutMs} мс`);
      }
      throw new Error(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
    // Ошибку Telegram отдаёт в теле и с кодом 4xx; текст описания
    // понятнее статуса — «Unauthorized» против «HTTP 401».
    const parsed = await response.json().catch(() => null) as
      { ok?: boolean; description?: string; result?: T } | null;
    if (!parsed?.ok) {
      throw new Error(parsed?.description || `Telegram ответил ${response.status}`);
    }
    return parsed.result as T;
  };

  return {
    async identify(token: string): Promise<{ id: number; username: string }> {
      const me = await call<{ id?: number; username?: string }>(token, "getMe", {});
      if (!me?.id || !me.username) throw new Error("Telegram не назвал бота");
      return { id: me.id, username: me.username };
    },

    async setWebhook(token: string, url: string, secret: string): Promise<void> {
      await call(token, "setWebhook", {
        url,
        secret_token: secret,
        allowed_updates: ALLOWED_UPDATES,
        // Очередь прежнего бота новому не принадлежит: это чужие
        // сообщения, отвечать на них задним числом незачем.
        drop_pending_updates: true,
      });
    },

    async deleteWebhook(token: string): Promise<void> {
      await call(token, "deleteWebhook", { drop_pending_updates: true });
    },

    /**
     * Вернуть звёзды по идентификатору списания.
     *
     * Возврат делает Telegram, а не мы: наша запись о нём — следствие, и
     * она ставится только после того, как возврат состоялся.
     */
    async refundStars(token: string, telegramUserId: number, chargeId: string): Promise<void> {
      await call(token, "refundStarPayment", {
        user_id: telegramUserId,
        telegram_payment_charge_id: chargeId,
      });
    },
  };
}
