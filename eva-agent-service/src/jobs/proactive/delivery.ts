/**
 * Доставка проактивного сообщения.
 *
 * Только durable outbox (требование 9 шага 8). Воркер не получает клиента
 * Telegram вовсе — это не соглашение, а устройство: отправить напрямую
 * ему нечем. Смысл в том, что переживает перезапуск: строка outbox
 * переживает, HTTP-запрос из упавшего воркера — нет.
 *
 * Ключ идемпотентности приходит снаружи и повторяет слот проактивного
 * сообщения. Две реплики, одновременно решившие написать, поставят одну
 * строку: `telegram_outbox` уникален по этому ключу.
 */

import type { OutboxDelivery } from "../../delivery/outbox.js";
import type { ProactiveDelivery } from "./service.js";

export class OutboxProactiveDelivery implements ProactiveDelivery {
  constructor(private readonly outbox: OutboxDelivery) {}

  async deliver(input: {
    userId: number;
    chatId: number;
    text: string;
    idempotencyKey: string;
  }): Promise<{ outboxId: string | null }> {
    let outboxId: string | null = null;
    await this.outbox.send({
      method: "sendMessage",
      chatId: input.chatId,
      userId: input.userId,
      payload: { chat_id: input.chatId, text: input.text },
      // Ступень «напоминание»: проактивное сообщение пропускает вперёд
      // ответ на живой вопрос и кризисный контур.
      priority: "reminder",
      idempotencyKey: input.idempotencyKey,
      onEnqueued: (id) => {
        outboxId = id;
      },
    });
    return { outboxId };
  }
}
