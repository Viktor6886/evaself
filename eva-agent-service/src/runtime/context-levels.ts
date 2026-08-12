/**
 * Уровни runtime context и их бюджеты.
 *
 * Раньше бюджет был один — общий предел знаков в `RuntimeContextBuilder`,
 * и при обрезке первым терялось то, что оказалось ниже по строке. Теперь
 * уровней пять, у каждого свой предел, и ФАКТИЧЕСКИЙ размер каждого
 * измеряется и записывается: «мы вроде уложились» — не измерение.
 *
 * Бюджеты взяты из `CLAUDE.md`, раздел «Бюджеты», и переведены в знаки:
 * токенизатор здесь не нужен, а знак — та единица, которой оперирует
 * сборка строки. Коэффициент один и тот же для всех уровней, поэтому
 * соотношение бюджетов сохраняется.
 */

export const CHARACTERS_PER_TOKEN = 4;

export const CONTEXT_LEVELS = [
  "always_on",
  "skills",
  "memory",
  "knowledge",
  "conversation",
] as const;

export type ContextLevel = (typeof CONTEXT_LEVELS)[number];

/** Пределы в знаках. `skills` — уже в знаках в `CLAUDE.md`. */
export const LEVEL_BUDGETS: Readonly<Record<ContextLevel, number>> = {
  always_on: 1_200 * CHARACTERS_PER_TOKEN,
  skills: 12_000,
  memory: 2_500 * CHARACTERS_PER_TOKEN,
  knowledge: 2_000 * CHARACTERS_PER_TOKEN,
  // Текущий разговор ведёт Letta, и полная стенограмма в промпт не
  // передаётся ни при каких условиях. Здесь — только то, что сборщик
  // добавляет сам.
  conversation: 1_000 * CHARACTERS_PER_TOKEN,
};

export interface LevelMeasurement {
  level: ContextLevel;
  characters: number;
  budget: number;
  /** Сколько строк выброшено пределом. Ноль — тоже факт. */
  dropped: number;
}

/**
 * Собрать уровень под бюджет.
 *
 * Обрезается по границе строки, а не по знаку: половина факта в
 * контексте хуже его отсутствия — модель достроит вторую половину сама.
 */
export function fitLevel(
  level: ContextLevel,
  lines: readonly string[],
  budget = LEVEL_BUDGETS[level],
): { lines: string[]; measurement: LevelMeasurement } {
  const kept: string[] = [];
  let characters = 0;
  let dropped = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (characters + cost > budget) { dropped += 1; continue; }
    characters += cost;
    kept.push(line);
  }
  return { lines: kept, measurement: { level, characters, budget, dropped } };
}

/** Сумма по уровням: она и есть измеренный размер контекста. */
export function totalCharacters(measurements: readonly LevelMeasurement[]): number {
  return measurements.reduce((sum, measurement) => sum + measurement.characters, 0);
}

/** Уровни, вышедшие за свой бюджет. Пустой список — тоже результат. */
export function overBudget(measurements: readonly LevelMeasurement[]): ContextLevel[] {
  return measurements
    .filter((measurement) => measurement.characters > measurement.budget)
    .map((measurement) => measurement.level);
}
