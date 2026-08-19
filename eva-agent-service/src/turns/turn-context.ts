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

export interface ActiveTurn {
  runId: string;
  /** Записан ли ход в `turn_runs`. Без записи ключ эффекта не на что вешать. */
  recorded: boolean;
  /** Отменён ли ход. Спрашивается, а не кэшируется: отмена приходит извне. */
  isCancelled: () => Promise<boolean>;
  /**
   * Сообщение, на которое отвечает этот ход, — доверенное, от Telegram.
   *
   * Реакция ставится именно на него. Раньше инструмент брал последнее
   * сообщение человека из базы, и с тех пор как поле ввода перестало
   * блокироваться, это стало прямой ошибкой: человек успевает написать
   * следующее, и реакция уезжает на чужой ход. У объединённого хода это
   * последнее сообщение того же окна.
   */
  chatId?: number;
  messageId?: number;
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
const byConversation = new Map<string, ActiveTurn>();

export function openTurnScope(conversationId: string, turn: ActiveTurn): void {
  byConversation.set(conversationId, turn);
}

export function closeTurnScope(conversationId: string): void {
  byConversation.delete(conversationId);
}

/**
 * Ход этого инструмента: сначала контекст, потом адрес по conversation.
 *
 * Порядок именно такой: контекст точнее — он гарантированно принадлежит
 * текущему асинхронному стеку, — а карта по conversation работает там,
 * где контекст не доехал.
 */
export function turnOf(conversationId: string | undefined): ActiveTurn | undefined {
  return currentTurn() ?? (conversationId ? byConversation.get(conversationId) : undefined);
}
