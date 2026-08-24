import assert from "node:assert/strict";
import test from "node:test";

import { GoalProgramService } from "../dist/goals/goal-program-service.js";
import { GoalService } from "../dist/goals/goal-service.js";

test("a goal cannot become active before explicit confirmation", async () => {
  let queries = 0;
  const goals = new GoalService({
    query: async () => {
      queries += 1;
      return { rows: [] };
    },
  } as never);

  await assert.rejects(
    goals.upsertGoal({
      userId: 41,
      title: "Запустить проверяемый прототип",
      status: "active",
    }),
    /confirm_goal/,
  );
  assert.equal(queries, 0);
});

test("confirmGoal activates only an owned goal with an explicit user scope", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const goals = new GoalService({
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: [{
          id: "17",
          user_id: "41",
          title: "Прототип",
          status: "active",
          user_confirmed: true,
        }],
      };
    },
  } as never);

  const confirmed = await goals.confirmGoal(41, 17) as {
    status: string;
    user_confirmed: boolean;
  };
  assert.equal(confirmed.status, "active");
  assert.equal(confirmed.user_confirmed, true);
  assert.deepEqual(calls[0]?.values, [17, 41]);
  assert.match(calls[0]?.sql ?? "", /id = \$1 AND user_id = \$2/);
});

test("completed work block stores fact and advances only the same user's goal", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("FROM goals")) {
        return {
          rows: [{ id: "9", user_id: "41", status: "active", user_confirmed: true }],
        };
      }
      if (sql.includes("FROM work_blocks")) {
        return {
          rows: [{
            id: "12",
            user_id: "41",
            goal_id: "9",
            goal_result_id: "7",
            status: "active",
          }],
        };
      }
      if (sql.includes("UPDATE work_blocks")) {
        return {
          rows: [{
            id: "12",
            status: "completed",
            actual_result: values[4],
          }],
        };
      }
      return { rows: [] };
    },
  };
  const goals = new GoalService({
    transaction: async (work: (value: typeof client) => Promise<unknown>) => await work(client),
  } as never);

  const block = await goals.recordWorkBlock({
    userId: 41,
    action: "complete",
    goalId: 9,
    workBlockId: 12,
    actualResult: "Собран работающий экран",
    artifact: "https://example.test/demo",
    obstacle: "Не хватало тестовых данных",
    helpfulFactor: "Короткий таймер",
    nextStep: "Показать двум пользователям",
    actualMinutes: 35,
    progressPercent: 60,
  }) as { status: string; actual_result: string };

  assert.equal(block.status, "completed");
  assert.equal(block.actual_result, "Собран работающий экран");
  const workUpdate = calls.find((call) => call.sql.includes("UPDATE work_blocks"));
  const goalUpdate = calls.find((call) => call.sql.includes("UPDATE goals"));
  assert.deepEqual(workUpdate?.values.slice(0, 3), [12, 41, 9]);
  assert.deepEqual(goalUpdate?.values, [9, 41]);
  assert.ok(calls.some((call) => call.sql.includes("vector_stage = 'feedback'")));
});

test("result dependencies outside the owned goal are rejected", async () => {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("INSERT INTO goal_results")) {
        return { rows: [{ id: "21", goal_id: "9", user_id: "41" }] };
      }
      if (sql.includes("id = ANY")) return { rows: [{ id: "2" }] };
      return { rows: [] };
    },
  };
  const goals = new GoalService({
    query: async (sql: string) => {
      if (sql.includes("FROM goals")) return { rows: [{ id: "9", user_id: "41" }] };
      return { rows: [] };
    },
    transaction: async (work: (value: typeof client) => Promise<unknown>) => await work(client),
  } as never);

  await assert.rejects(
    goals.upsertGoalResult({
      userId: 41,
      goalId: 9,
      title: "Проверить сценарий",
      dependsOnResultIds: [2, 3],
    }),
    /не принадлежит этой цели/,
  );
});

// ---------------------------------------------------------------------
// Курсор длинной guided-программы
// ---------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Фейк одной таблицы `goal_program_runs`.
 *
 * Повторяет ровно те правила выборки, которые SQL обязан обеспечивать:
 * область арендатора, один незакрытый запуск на ключ методики и условие
 * по ревизии при записи. Сам SQL проверяет CI на настоящей базе.
 */
function programDb(seed: Row[] = []) {
  const rows: Row[] = seed.map((row) => ({ ...row }));
  let nextId = rows.length + 1;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    calls,
    rows,
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes("FROM goals")) {
        // Цель 7 принадлежит пользователю 41 и больше никому.
        const [goalId, userId] = values as [number, number];
        return { rows: goalId === 7 && userId === 41 ? [{ id: "7" }] : [] };
      }
      if (sql.startsWith("SELECT") && sql.includes("goal_program_runs")) {
        const [userId, key] = values as [number, string | null];
        const open = sql.includes("status IN ('active', 'paused')");
        return {
          rows: rows.filter((row) =>
            row.user_id === userId
            && (key === null || row.program_key === key)
            && (!open || row.status === "active" || row.status === "paused")),
        };
      }
      if (sql.startsWith("INSERT INTO goal_program_runs")) {
        const [userId, key, version, goalId, phase, step, nextStep, hint, resume] =
          values as [number, string, number, number | null, string | null,
            string | null, string | null, string | null, string];
        // Зеркало частичного уникального индекса и ON CONFLICT DO NOTHING:
        // второй открытый запуск не создаётся и строк не возвращает.
        if (rows.some((row) =>
          row.user_id === userId && row.program_key === key
          && (row.status === "active" || row.status === "paused"))) {
          return { rows: [] };
        }
        const created: Row = {
          id: String(nextId++), user_id: userId, program_key: key,
          program_version: version, primary_goal_id: goalId, status: "active",
          phase_key: phase, step_key: step, last_completed_step_key: null,
          next_step_key: nextStep, next_action_hint: hint, resume_policy: resume,
          revision: 1, started_at: "t", last_progress_at: "t", completed_at: null,
        };
        rows.push(created);
        return { rows: [created] };
      }
      if (sql.startsWith("UPDATE goal_program_runs")) {
        const [id, userId, status, phase, step, done, nextStep, hint, resume,
          goalId, terminal, revision] = values as [number, number, string,
            string | null, string | null, string | null, string | null,
            string | null, string, number | null, boolean, number];
        const found = rows.find((row) =>
          Number(row.id) === id && row.user_id === userId
          && Number(row.revision) === revision);
        if (!found) return { rows: [] };
        Object.assign(found, {
          status, phase_key: phase, step_key: step, last_completed_step_key: done,
          next_step_key: nextStep, next_action_hint: hint, resume_policy: resume,
          primary_goal_id: goalId, revision: Number(found.revision) + 1,
          completed_at: terminal ? "t" : null,
        });
        return { rows: [found] };
      }
      return { rows: [] };
    },
  };
  return db;
}

test("повторный start незакрытой программы не начинает методику заново", async () => {
  // Это и есть чинимое поведение: слабая модель на новом ходе зовёт
  // start и теряет пройденные шаги. Сохранённое место возвращается как
  // есть, вторая запись не создаётся.
  const db = programDb();
  const programs = new GoalProgramService(db as never);

  const started = await programs.update({
    userId: 41, action: "start", programKey: "planning-30d",
    phaseKey: "intake", stepKey: "step-1",
  });
  assert.equal(started.applied, true);
  assert.equal(started.run.status, "active");

  const again = await programs.update({
    userId: 41, action: "start", programKey: "planning-30d", stepKey: "step-1",
  });
  assert.equal(again.applied, false);
  assert.equal(again.run.id, started.run.id);
  assert.equal(db.rows.length, 1);
});

test("advance двигает курсор, пауза и возобновление его не теряют", async () => {
  const db = programDb();
  const programs = new GoalProgramService(db as never);
  await programs.update({
    userId: 41, action: "start", programKey: "planning-30d",
    phaseKey: "intake", stepKey: "step-1", nextStepKey: "step-2",
  });

  const advanced = await programs.update({
    userId: 41, action: "advance", programKey: "planning-30d",
    phaseKey: "mapping", stepKey: "step-2", lastCompletedStepKey: "step-1",
    nextStepKey: "step-3", nextActionHint: "выбрать три результата",
  });
  assert.equal(advanced.applied, true);
  assert.equal(advanced.run.revision, 2);

  const paused = await programs.update({
    userId: 41, action: "pause", programKey: "planning-30d",
  });
  assert.equal(paused.run.status, "paused");
  // Пауза — это не забывание: место остаётся ровно тем же.
  assert.equal(paused.run.step_key, "step-2");
  assert.equal(paused.run.last_completed_step_key, "step-1");
  assert.equal(paused.run.next_step_key, "step-3");

  const resumed = await programs.update({
    userId: 41, action: "resume", programKey: "planning-30d",
  });
  assert.equal(resumed.run.status, "active");
  assert.equal(resumed.run.step_key, "step-2");
  assert.equal(resumed.run.next_action_hint, "выбрать три результата");
});

test("новый разговор видит сохранённый шаг, а не начало методики", async () => {
  // Между ходами нет ни conversation, ни истории — только курсор.
  const db = programDb();
  const first = new GoalProgramService(db as never);
  await first.update({
    userId: 41, action: "start", programKey: "planning-30d", stepKey: "step-1",
  });
  await first.update({
    userId: 41, action: "advance", programKey: "planning-30d",
    stepKey: "step-7", lastCompletedStepKey: "step-6", nextStepKey: "step-8",
  });

  const later = new GoalProgramService(db as never);
  const context = await later.getContext(41);
  assert.equal(context.active?.step_key, "step-7");
  assert.equal(context.active?.next_step_key, "step-8");
});

test("завершённая программа не продвигается дальше", async () => {
  const db = programDb();
  const programs = new GoalProgramService(db as never);
  await programs.update({
    userId: 41, action: "start", programKey: "planning-30d", stepKey: "step-1",
  });
  const done = await programs.update({
    userId: 41, action: "complete", programKey: "planning-30d",
  });
  assert.equal(done.run.status, "completed");
  assert.notEqual(done.run.completed_at, null);

  await assert.rejects(
    programs.update({ userId: 41, action: "advance", programKey: "planning-30d" }),
    /start/,
  );
  // Терминальный запуск не попадает в активные и не тянется в каждый ход.
  const context = await programs.getContext(41);
  assert.equal(context.active, null);
  assert.equal(context.runs.length, 1);
});

test("устаревшая и повторная запись не затирают чужой шаг", async () => {
  const db = programDb();
  const programs = new GoalProgramService(db as never);
  await programs.update({
    userId: 41, action: "start", programKey: "planning-30d", stepKey: "step-1",
  });
  await programs.update({
    userId: 41, action: "advance", programKey: "planning-30d", stepKey: "step-2",
  });

  // Ревизия из хода, открытого до чужого обновления.
  await assert.rejects(
    programs.update({
      userId: 41, action: "advance", programKey: "planning-30d",
      stepKey: "step-9", expectedRevision: 1,
    }),
    /get_goal_program_context/,
  );

  // Повтор того же шага — не изменение: ревизия не растёт, иначе честный
  // expected_revision следующего хода отвергался бы на ровном месте.
  const repeat = await programs.update({
    userId: 41, action: "advance", programKey: "planning-30d",
    stepKey: "step-2", expectedRevision: 2,
  });
  assert.equal(repeat.applied, false);
  assert.equal(repeat.run.revision, 2);
});

test("курсор программы читается и пишется только в области владельца", async () => {
  const db = programDb([{
    id: "1", user_id: 41, program_key: "planning-30d", program_version: 1,
    primary_goal_id: null, status: "active", phase_key: null, step_key: "step-3",
    last_completed_step_key: null, next_step_key: null, next_action_hint: null,
    resume_policy: "contextual", revision: 1,
    started_at: "t", last_progress_at: "t", completed_at: null,
  }]);
  const programs = new GoalProgramService(db as never);

  const stranger = await programs.getContext(42);
  assert.equal(stranger.runs.length, 0);
  assert.equal(stranger.active, null);
  for (const call of db.calls) {
    assert.match(call.sql, /user_id = \$1/);
  }

  // Чужая цель не привязывается к программе даже по прямому указанию.
  await assert.rejects(
    programs.update({
      userId: 42, action: "start", programKey: "coaching", primaryGoalId: 7,
    }),
    /Цель программы не найдена/,
  );
});

test("одновременный start не падает на индексе, а отдаёт то же место", async () => {
  // Ход человека, восстановление после сбоя и фоновое задание могут
  // позвать start одновременно. Индекс второй открытый запуск не пустит;
  // ответом должно быть сохранённое место, а не ошибка уникальности.
  const db = programDb();
  const programs = new GoalProgramService(db as never);
  const [first, second] = await Promise.all([
    programs.update({
      userId: 41, action: "start", programKey: "planning-30d", stepKey: "step-1",
    }),
    programs.update({
      userId: 41, action: "start", programKey: "planning-30d", stepKey: "step-1",
    }),
  ]);

  assert.equal(db.rows.length, 1, "создано больше одного открытого запуска");
  assert.equal(first.run.id, second.run.id);
  assert.equal([first.applied, second.applied].filter(Boolean).length, 1);
  const inserts = db.calls.filter(({ sql }) =>
    sql.startsWith("INSERT INTO goal_program_runs"));
  for (const { sql } of inserts) {
    assert.match(sql, /ON CONFLICT \(user_id, program_key\)/);
    assert.match(sql, /WHERE status IN \('active', 'paused'\)/);
  }
});
