/**
 * Пауза для цикла событий по прошедшему времени, а не по числу строк.
 *
 * Строка файла стоит и микросекунду, и десяток миллисекунд: пауза «раз в
 * 500 строк» на дорогих строках наступала через секунду, и всё это время
 * ходы Евы других людей стояли. Разбор отдаёт цикл, как только подряд
 * набежало `QUANTUM_MS`, — чужой ход ждёт не дольше этого и одной строки.
 */

export const QUANTUM_MS = 20;

export const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Для асинхронных циклов: `await pace()` на каждом шаге. */
export function pacer(quantum = QUANTUM_MS): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < quantum) return;
    await pause();
    since = performance.now();
  };
}

/**
 * Для синхронного перебора: `true` — пора отдать цикл, вызывающий делает
 * `await pause()`. Часы — на каждом шаге: шаг перебора токенов стоит
 * десятки наносекунд, и `performance.now()` к нему добавляет немного.
 */
export function clock(quantum = QUANTUM_MS): () => boolean {
  let since = performance.now();
  let pausing = false;
  return () => {
    const now = performance.now();
    // Первый шаг после паузы начинает новый отсчёт: время, пока работали
    // другие, не в счёт.
    if (pausing) {
      pausing = false;
      since = now;
      return false;
    }
    if (now - since < quantum) return false;
    pausing = true;
    return true;
  };
}
