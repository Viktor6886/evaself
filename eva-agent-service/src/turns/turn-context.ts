/**
 * Контекст текущего хода.
 *
 * Инструмент выполняется глубоко внутри Agent SDK и о ходе, который его
 * вызвал, ничего не знает. Прокинуть `run_id` параметром нельзя: между
 * ходом и инструментом лежит чужой код. Поэтому контекст живёт в
 * AsyncLocalStorage — там же, где уже живёт область арендатора, и по той
 * же причине.
 *
 * Что здесь есть: идентификатор хода и способ спросить, не отменён ли он.
 * Чего нет и не будет: содержимого разговора.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ActiveTurn {
  runId: string;
  /** Записан ли ход в `turn_runs`. Без записи ключ эффекта не на что вешать. */
  recorded: boolean;
  /** Отменён ли ход. Спрашивается, а не кэшируется: отмена приходит извне. */
  isCancelled: () => Promise<boolean>;
}

const storage = new AsyncLocalStorage<ActiveTurn>();

export function runInTurn<T>(turn: ActiveTurn, work: () => Promise<T>): Promise<T> {
  return storage.run(turn, work);
}

export function currentTurn(): ActiveTurn | undefined {
  return storage.getStore();
}
