/**
 * Недельный обзор.
 *
 * Считает его серверный код, а не модель. Причина та же, по которой
 * баллы психометрии считает код (инвариант 25): обзор — это утверждение о
 * человеке, и оно обязано быть воспроизводимым. Одни и те же семь дней
 * обязаны давать один и тот же обзор.
 *
 * Второе правило — честный отказ. Бюджет из `CLAUDE.md`: сигнал не
 * показывается при выборке меньше пяти наблюдений. Обзор, собранный из
 * двух отметок, выглядит так же уверенно, как обзор из тридцати, и
 * именно поэтому его нельзя показывать: человек не отличит.
 */

import type { Database } from "../../db.js";

/** Ниже этого числа наблюдений вывод не делается вовсе. */
export const MIN_OBSERVATIONS = 5;

export interface WeeklyReviewSection {
  key: "mood" | "journal" | "goals" | "actions";
  title: string;
  /** `null` — данных недостаточно; это состояние, а не пустая строка. */
  finding: string | null;
  observations: number;
  sufficient: boolean;
}

export interface WeeklyReview {
  from: string;
  to: string;
  /** Достаточен ли объём данных хотя бы для одного вывода. */
  sufficient: boolean;
  summary: string;
  sections: WeeklyReviewSection[];
  totals: {
    entries: number;
    checkins: number;
    completed_tasks: number;
    completed_results: number;
    active_goals: number;
  };
}

interface WeeklyRow {
  entries: string;
  entries_with_mood: string;
  avg_journal_mood: string | null;
  checkins: string;
  avg_energy: string | null;
  avg_tension: string | null;
  high_tension_days: string;
  completed_tasks: string;
  completed_results: string;
  active_goals: string;
  people_mentions: string;
}

const MOOD_SCORE: Record<string, number> = {
  very_low: 1,
  low: 2,
  neutral: 3,
  good: 4,
  great: 5,
};

/**
 * Все счётчики берутся одним запросом. Не ради скорости: разные запросы
 * попадают на разные моменты времени, и обзор мог бы посчитать запись,
 * созданную между двумя выборками, в одном разделе и не посчитать в
 * другом.
 */
export async function weeklyReview(
  db: Database,
  user: { id: number; timezone: string },
  options: { days?: number } = {},
): Promise<WeeklyReview> {
  const days = Math.min(31, Math.max(7, Math.trunc(options.days ?? 7)));
  const { rows } = await db.query<WeeklyRow & { period_from: string; period_to: string }>(
    `WITH bounds AS (
       SELECT (now() AT TIME ZONE $2)::date - ($3::integer - 1) AS period_from,
              (now() AT TIME ZONE $2)::date AS period_to
     )
     SELECT bounds.period_from::text, bounds.period_to::text,
       (SELECT count(*) FROM journal_entries
         WHERE user_id = $1 AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS entries,
       (SELECT count(*) FROM journal_entries
         WHERE user_id = $1 AND mood IS NOT NULL
           AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS entries_with_mood,
       (SELECT round(avg(CASE mood
                           WHEN 'very_low' THEN 1 WHEN 'low' THEN 2
                           WHEN 'neutral' THEN 3 WHEN 'good' THEN 4
                           WHEN 'great' THEN 5 END), 2)::text
          FROM journal_entries
         WHERE user_id = $1 AND mood IS NOT NULL
           AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS avg_journal_mood,
       (SELECT count(*) FROM user_checkins
         WHERE user_id = $1 AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS checkins,
       (SELECT round(avg(energy), 1)::text FROM user_checkins
         WHERE user_id = $1 AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS avg_energy,
       (SELECT round(avg(tension), 1)::text FROM user_checkins
         WHERE user_id = $1 AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS avg_tension,
       (SELECT count(*) FROM user_checkins
         WHERE user_id = $1 AND tension >= 7
           AND local_date BETWEEN bounds.period_from AND bounds.period_to) AS high_tension_days,
       (SELECT count(*) FROM tasks
         WHERE user_id = $1 AND status = 'done'
           AND (completed_at AT TIME ZONE $2)::date BETWEEN bounds.period_from AND bounds.period_to) AS completed_tasks,
       (SELECT count(*) FROM goal_results
         WHERE user_id = $1 AND status = 'completed'
           AND (completed_at AT TIME ZONE $2)::date BETWEEN bounds.period_from AND bounds.period_to) AS completed_results,
       (SELECT count(*) FROM goals WHERE user_id = $1 AND status = 'active') AS active_goals,
       (SELECT count(*) FROM journal_entry_people ep
          JOIN journal_entries e ON e.id = ep.entry_id AND e.user_id = ep.user_id
         WHERE ep.user_id = $1
           AND e.local_date BETWEEN bounds.period_from AND bounds.period_to) AS people_mentions
     FROM bounds`,
    [user.id, user.timezone, days],
  );

  const row = rows[0];
  const entries = Number(row?.entries ?? 0);
  const entriesWithMood = Number(row?.entries_with_mood ?? 0);
  const checkins = Number(row?.checkins ?? 0);
  const completedTasks = Number(row?.completed_tasks ?? 0);
  const completedResults = Number(row?.completed_results ?? 0);
  const activeGoals = Number(row?.active_goals ?? 0);

  const sections: WeeklyReviewSection[] = [
    moodSection(checkins, entriesWithMood, row),
    journalSection(entries, Number(row?.people_mentions ?? 0)),
    actionsSection(completedTasks, completedResults),
    goalsSection(activeGoals, completedResults),
  ];

  const sufficient = sections.some((section) => section.sufficient);
  return {
    from: String(row?.period_from ?? ""),
    to: String(row?.period_to ?? ""),
    sufficient,
    summary: sufficient
      ? sections
        .filter((section) => section.finding)
        .map((section) => section.finding)
        .join(" ")
      : `За период набралось ${entries + checkins} ${plural(entries + checkins, "наблюдение", "наблюдения", "наблюдений")}. `
        + `Для честного вывода нужно хотя бы ${MIN_OBSERVATIONS} — пока обзор его не делает.`,
    sections,
    totals: {
      entries,
      checkins,
      completed_tasks: completedTasks,
      completed_results: completedResults,
      active_goals: activeGoals,
    },
  };
}

function moodSection(
  checkins: number,
  entriesWithMood: number,
  row: WeeklyRow | undefined,
): WeeklyReviewSection {
  // Настроение приходит из двух источников — отметок состояния и записей
  // дневника. Складывать их в одно среднее нельзя: шкалы разные по
  // смыслу. А вот считать наблюдения вместе можно: вопрос «хватает ли
  // данных» относится к объёму, а не к шкале.
  const observations = checkins + entriesWithMood;
  if (observations < MIN_OBSERVATIONS) {
    return {
      key: "mood",
      title: "Состояние",
      finding: null,
      observations,
      sufficient: false,
    };
  }
  const energy = Number(row?.avg_energy ?? 0);
  const tension = Number(row?.avg_tension ?? 0);
  const high = Number(row?.high_tension_days ?? 0);
  const journalMood = row?.avg_journal_mood ? Number(row.avg_journal_mood) : null;
  const parts: string[] = [];
  if (checkins > 0) {
    parts.push(`Средняя энергия ${energy}/10, напряжение ${tension}/10.`);
  }
  if (high >= 3) {
    parts.push(
      `Напряжение было высоким в ${high} ${plural(high, "день", "дня", "дней")} — это наблюдение, а не диагноз.`,
    );
  }
  if (journalMood !== null) {
    parts.push(`Настроение в записях — около «${moodLabel(journalMood)}».`);
  }
  return {
    key: "mood",
    title: "Состояние",
    finding: parts.join(" "),
    observations,
    sufficient: true,
  };
}

function journalSection(entries: number, mentions: number): WeeklyReviewSection {
  if (entries < MIN_OBSERVATIONS) {
    return { key: "journal", title: "Дневник", finding: null, observations: entries, sufficient: false };
  }
  return {
    key: "journal",
    title: "Дневник",
    finding: `${entries} ${plural(entries, "запись", "записи", "записей")} за период`
      + (mentions > 0
        ? `, в ${mentions} ${plural(mentions, "упоминание", "упоминания", "упоминаний")} других людей.`
        : "."),
    observations: entries,
    sufficient: true,
  };
}

function actionsSection(tasks: number, results: number): WeeklyReviewSection {
  const observations = tasks + results;
  if (observations < MIN_OBSERVATIONS) {
    return { key: "actions", title: "Сделано", finding: null, observations, sufficient: false };
  }
  return {
    key: "actions",
    title: "Сделано",
    finding: `Закрыто ${tasks} ${plural(tasks, "задача", "задачи", "задач")}`
      + (results > 0
        ? ` и ${results} ${plural(results, "результат", "результата", "результатов")} по целям.`
        : "."),
    observations,
    sufficient: true,
  };
}

function goalsSection(activeGoals: number, results: number): WeeklyReviewSection {
  // Цели — единственный раздел, где порог не в наблюдениях за период:
  // одна активная цель без результатов за неделю сама по себе факт, а не
  // недостаток данных. Но и вывода из неё не делается — только счёт.
  if (activeGoals === 0) {
    return { key: "goals", title: "Цели", finding: null, observations: 0, sufficient: false };
  }
  return {
    key: "goals",
    title: "Цели",
    finding: results > 0
      ? `${activeGoals} ${plural(activeGoals, "активная цель", "активные цели", "активных целей")}, продвижение за период есть.`
      : `${activeGoals} ${plural(activeGoals, "активная цель", "активные цели", "активных целей")}; завершённых результатов за период нет.`,
    observations: activeGoals,
    sufficient: true,
  };
}

function moodLabel(score: number): string {
  const nearest = Object.entries(MOOD_SCORE)
    .sort((a, b) => Math.abs(a[1] - score) - Math.abs(b[1] - score))[0]?.[0] ?? "neutral";
  return ({
    very_low: "тяжёлое",
    low: "сниженное",
    neutral: "спокойное",
    good: "хорошее",
    great: "отличное",
  } as Record<string, string>)[nearest]!;
}

function plural(count: number, one: string, few: string, many: string): string {
  const n10 = count % 10;
  const n100 = count % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return few;
  return many;
}
