/**
 * Вынос CPU-тяжёлой работы из основного event loop.
 *
 * Фоновое задание живёт в том же процессе, что и вебхук Telegram.
 * Синхронный разбор большого JSON, подсчёт эмбеддингов на CPU или
 * сортировка десятков тысяч строк займут event loop целиком, и на это
 * время сервис перестанет отвечать не только по фоновой части: ответ
 * человеку тоже ждёт своей очереди. Поэтому такая работа выполняется в
 * рабочем потоке.
 *
 * Поток создаётся на задачу и умирает вместе с ней. Пул здесь был бы
 * преждевременным: тяжёлых задач пока нет ни одной, а живущий пул
 * держит память и переживает выкатку. Появится нагрузка — появится и
 * пул, в этом же файле.
 *
 * Модуль задачи задаётся путём, а не функцией: функцию нельзя передать
 * в поток, а `eval` переданного кода означал бы выполнение
 * произвольного JavaScript — прямой запрет из `CLAUDE.md`.
 */

import { Worker } from "node:worker_threads";

export interface CpuTaskOptions {
  /** Прерывание по мягкому сроку задания или потере аренды. */
  signal?: AbortSignal;
  /** Собственный предел задачи. Поток за его пределами останавливается. */
  timeoutMs: number;
}

export class CpuTaskError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CpuTaskError";
  }
}

/**
 * Выполнить задачу в рабочем потоке.
 *
 * `modulePath` — путь к модулю внутри сервиса. Модуль обязан слать
 * результат через `parentPort.postMessage` и завершаться сам.
 */
export async function runCpuTask<T>(
  modulePath: string | URL,
  payload: unknown,
  options: CpuTaskOptions,
): Promise<T> {
  if (options.signal?.aborted) throw new CpuTaskError("cpu_task_aborted");
  const worker = new Worker(modulePath, { workerData: payload });

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Поток останавливается в любом исходе: брошенный поток продолжит
      // занимать ядро и переживёт то задание, ради которого он создан.
      void worker.terminate();
      action();
    };
    const onAbort = (): void => {
      finish(() => reject(new CpuTaskError("cpu_task_aborted")));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new CpuTaskError("cpu_task_timeout")));
    }, options.timeoutMs);
    timer.unref();

    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (value: T) => finish(() => resolve(value)));
    worker.once("error", (error: Error) => {
      // Наружу уходит только имя ошибки: сообщение потока может
      // содержать те данные, ради которых поток и запускался.
      finish(() => reject(new CpuTaskError("cpu_task_failed", error.name)));
    });
    worker.once("exit", (code: number) => {
      if (code === 0) finish(() => reject(new CpuTaskError("cpu_task_no_result")));
      else finish(() => reject(new CpuTaskError("cpu_task_exit", String(code))));
    });
  });
}
