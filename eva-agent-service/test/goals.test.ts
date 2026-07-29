import assert from "node:assert/strict";
import test from "node:test";

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
