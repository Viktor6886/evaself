/**
 * Контекст текущего хода.
 *
 * Инструмент выполняется глубоко внутри Agent SDK и о ходе, который его
 * вызвал, ничего не знает. Прокинуть `run_id` параметром нельзя: между
 * ходом и инструментом лежит чужой код. Поэтому контекст живёт в
 * AsyncLocalStorage — там же, где уже живёт область арендатора, и по той
 * же причине.
 *
 * Что здесь есть: идентификатор хода, способ спросить, не отменён ли он,
 * и сообщение, на которое этот ход отвечает. Чего нет и не будет:
 * содержимого разговора.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type { InlineChoiceIntent } from "../telegram/inline-choices.js";

export interface ReactionTarget {
  /** Every field comes from the same real inbound Telegram update. */
  updateId: number;
  telegramUserId: number;
  chatId: number;
  messageId: number;
}

export type ReactionOutcome =
  | { outcome: "skipped"; reason: "model_not_called" | "emoji_disabled" | "no_reaction_target" | "stale_reaction_target" }
  | { outcome: "failed"; reason: "unsupported_reaction" | "telegram_api_error" }
  | { outcome: "succeeded"; reason: "delivered" };

export interface ActiveTurn {
  /** Conversation, которому принадлежит ход. Нужен для защиты от чужого ALS. */
  conversationId?: string;
  runId: string;
  /** Записан ли ход в `turn_runs`. Без записи ключ эффекта не на что вешать. */
  recorded: boolean;
  /** Отменён ли ход. Спрашивается, а не кэшируется: отмена приходит извне. */
  isCancelled: () => Promise<boolean>;
  /** Адрес чата и ID реплики хода. Не являются целью реакции. */
  chatId?: number;
  messageId?: number;
  /**
   * Доверенная цель реакции, назначенная сервером.
   *
   * Она существует только для настоящего входящего сообщения человека.
   * Callback, poll_answer и другие синтетические ходы никогда не получают
   * её, даже если для связи хода у них есть messageId сообщения бота.
   */
  reactionTarget?: ReactionTarget | null;
  /** Структурированный итог социального решения этого хода. */
  reactionOutcome?: ReactionOutcome;
  /**
   * Оформление, которое Ева попросила добавить к своему ответу.
   *
   * Живёт ровно до конца хода: кнопки относятся к тому ответу, который
   * сейчас пишется, и переносить их на следующий нельзя. Отменённый ход
   * уносит намерение с собой — недописанный ответ не должен оставить
   * висящую клавиатуру.
   */
  ui?: { inlineChoices?: InlineChoiceIntent };
}

const storage = new AsyncLocalStorage<ActiveTurn>();

export function runInTurn<T>(turn: ActiveTurn, work: () => Promise<T>): Promise<T> {
  return storage.run(turn, work);
}

export function currentTurn(): ActiveTurn | undefined {
  return storage.getStore();
}

/**
 * Ход, привязанный к conversation, — рядом с контекстом, но не он.
 *
 * Инструменты регистрируются при ОТКРЫТИИ сессии, а не на каждый ход:
 * замыкание инструмента создаётся в одном асинхронном контексте, а
 * вызывается позже, из обработчика сокета SDK, — и AsyncLocalStorage
 * туда не дотягивается. В production это выглядело так: Ева отвечала
 * «нет сообщения этого хода для реакции» на любую просьбу поставить
 * реакцию, потому что `currentTurn()` внутри инструмента возвращал
 * пустоту.
 *
 * Поэтому у хода есть второй адрес — по conversation, который инструмент
 * знает из своего runtime. Хранится ровно то же самое и ровно так же
 * недолго: запись живёт от начала хода до его конца.
 */
export interface TurnScope {
  readonly conversationId: string;
  readonly turn: ActiveTurn;
  readonly token: symbol;
}

const byConversation = new Map<string, TurnScope>();

export function openTurnScope(conversationId: string, turn: ActiveTurn): TurnScope {
  const scope = Object.freeze({ conversationId, turn, token: Symbol(conversationId) });
  byConversation.set(conversationId, scope);
  return scope;
}

export function closeTurnScope(scope: TurnScope): void {
  // Старый ход может завершиться после нового. Он не имеет права снять
  // scope, который уже принадлежит более свежему ходу.
  if (byConversation.get(scope.conversationId) === scope) {
    byConversation.delete(scope.conversationId);
  }
}

/**
 * Ход этого инструмента: сначала контекст, потом адрес по conversation.
 *
 * Порядок именно такой: контекст точнее — он гарантированно принадлежит
 * текущему асинхронному стеку, — а карта по conversation работает там,
 * где контекст не доехал.
 */
export function turnOf(conversationId: string | undefined): ActiveTurn | undefined {
  const ambient = currentTurn();
  if (ambient && (!ambient.conversationId || ambient.conversationId === conversationId)) {
    return ambient;
  }
  return conversationId ? byConversation.get(conversationId)?.turn : undefined;
}
