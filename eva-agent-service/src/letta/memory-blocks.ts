/**
 * Шесть memory blocks Евы — их состав, границы и порядок.
 *
 * Набор закрыт инвариантом 28 и не расширяется. Вынесен из `letta.ts`
 * отдельным модулем, чтобы проверка содержимого артефакта не платила
 * чтением полуторатысячестрочного файла за шесть литералов.
 *
 * Значения по умолчанию — заглушки, а не содержание: блоки наполняет
 * сама Letta, и она же остаётся единственным их источником истины.
 */

/** Шесть меток. Список закрыт инвариантом 28 и совпадает с ограничением таблицы. */
export const SYNCED_BLOCK_LABELS = [
  "persona",
  "human",
  "current_state",
  "goals_and_commitments",
  "relationships_and_patterns",
  "progress_and_hypotheses",
] as const;

export type SyncedBlockLabel = (typeof SYNCED_BLOCK_LABELS)[number];

export interface EvaMemoryBlock {
  label: string;
  value: string;
  description?: string | null;
  read_only?: boolean;
  hidden?: boolean | null;
  limit?: number;
}

export function evaMemoryBlocks(
  persona = "Персона Евы загружается из системной конфигурации.",
  human = "Проверенные сведения о пользователе пока не заполнены.",
): EvaMemoryBlock[] {
  return [
    {
      label: "persona",
      value: persona,
      description: "Устойчивая персона и правила поведения Евы",
      limit: 15_000,
    },
    {
      label: "human",
      value: human,
      description: "Только проверенные сведения о текущем пользователе",
      limit: 10_000,
    },
    {
      label: "current_state",
      value: "Актуальное состояние пока не описано.",
      description: "Краткий текущий контекст, эмоции и жизненная ситуация",
      limit: 8_000,
    },
    {
      label: "goals_and_commitments",
      value: "Подтверждённых целей и обязательств пока нет.",
      description: "Цели и обязательства пользователя, сформулированные его словами",
      limit: 12_000,
    },
    {
      label: "relationships_and_patterns",
      value: "Карта значимых людей, тем и связей пока пуста.",
      description: "Подтверждённые связи людей, событий, ценностей и повторяющихся тем",
      limit: 12_000,
    },
    {
      label: "progress_and_hypotheses",
      value: "Наблюдений о прогрессе и проверяемых гипотез пока нет.",
      description: "Прогресс и осторожные гипотезы, которые нужно сверять с пользователем",
      limit: 12_000,
    },
  ];
}

/**
 * Достроить обязательные блоки, если административный запрос их не прислал.
 *
 * Агент без `persona` и `human` работоспособен, но безлик: правила
 * поведения и сведения о человеке взять неоткуда. Поэтому они добавляются
 * молча, а не отвергают запрос.
 */
export function ensureCoreMemoryBlocks(
  memory: EvaMemoryBlock[],
  persona: string,
  human: string,
): EvaMemoryBlock[] {
  const result = memory.map((block) => ({ ...block }));
  if (!result.some((block) => block.label === "persona")) {
    result.unshift({
      label: "persona",
      value: persona,
      description: "Устойчивая персона и правила поведения Евы",
      limit: 15_000,
    });
  }
  if (!result.some((block) => block.label === "human")) {
    result.splice(1, 0, {
      label: "human",
      value: human,
      description: "Проверенные сведения о текущем пользователе",
      limit: 10_000,
    });
  }
  return result;
}
