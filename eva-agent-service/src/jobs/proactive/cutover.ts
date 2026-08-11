/**
 * Кто сейчас владеет задачей: старый интервал или очередь.
 *
 * Главное свойство переноса — задача не должна исполняться дважды. Два
 * механизма, одновременно считающие себя ответственными, дадут человеку
 * два одинаковых сообщения, и виноватым будет выглядеть агент, а не
 * конфигурация. Поэтому владение выражено значением, а не набором
 * разрозненных `if` по флагам в двух модулях.
 *
 * Ступени ровно три, и средняя обязательна (требование 3 шага 8):
 *
 *   legacy  — работает только старый интервал; очередь выключена;
 *   mirror  — работает старый интервал, очередь ТОЛЬКО выбирает и
 *             сравнивает выборку, ничего не отправляя;
 *   queue   — работает очередь, старый интервал не запускается.
 *
 * Перейти из `mirror` в `queue` человек имеет право только после
 * доказанного совпадения выборки: доказательство лежит в
 * `job_mirror_samples` и читается `MirrorRecorder.readyToCutOver`.
 */

export type ProactiveStage = "legacy" | "mirror" | "queue";

export interface CutoverConfig {
  /** Флаг `EVA_BULLMQ_PROACTIVE`. Выключен — очередь не участвует вовсе. */
  proactiveEnabled: boolean;
  /** Флаг `EVA_JOBS_MIRROR`. Включён — очередь только наблюдает. */
  mirrorMode: boolean;
}

export function proactiveStage(config: CutoverConfig): ProactiveStage {
  if (!config.proactiveEnabled) return "legacy";
  return config.mirrorMode ? "mirror" : "queue";
}

/** Запускать ли старые интервалы напоминаний и heartbeat. */
export function legacySchedulerActive(stage: ProactiveStage): boolean {
  return stage !== "queue";
}

/** Имеет ли очередь право отправлять, а не только выбирать. */
export function queueMayDispatch(stage: ProactiveStage): boolean {
  return stage === "queue";
}
