import type { Database } from "../db.js";
import type { GraphRepository } from "../memory/graph-repository.js";
import type { RuntimeContextBuilder } from "../runtime/runtime-context.js";

type JsonObject = Record<string, unknown>;

const GOAL_STATUSES = new Set(["draft", "active", "paused", "completed", "abandoned"]);
const VECTOR_STAGES = new Set(["north", "result", "map", "action", "feedback", "review"]);
const RESULT_STATUSES = new Set(["draft", "ready", "in_progress", "completed", "blocked", "skipped"]);
const REVIEW_TYPES = new Set(["feedback", "deviation", "checkpoint", "weekly", "completion"]);

export interface UpsertGoalInput {
  userId: number;
  id?: number;
  parentGoalId?: number | null;
  lifeArea?: string | null;
  horizon?: string | null;
  title?: string;
  whyItMatters?: string | null;
  resultArtifact?: string | null;
  targetDate?: string | null;
  successCriteria?: unknown;
  minimumVersion?: string | null;
  targetVersion?: string | null;
  constraints?: unknown;
  learningGoal?: string | null;
  reviewCondition?: string | null;
  stopCondition?: string | null;
  priority?: number;
  status?: string;
  vectorStage?: string;
  nextReviewAt?: string | null;
  north?: {
    desiredDirection?: string | null;
    whyItMatters?: string | null;
    values?: unknown;
    acceptableCost?: string | null;
    unacceptableCost?: string | null;
    conflicts?: unknown;
    reduceList?: unknown;
    userConfirmed?: boolean;
  };
}

export interface UpsertGoalResultInput {
  userId: number;
  goalId: number;
  id?: number;
  parentResultId?: number | null;
  title?: string;
  resultArtifact?: string | null;
  successCriteria?: unknown;
  minimumVersion?: string | null;
  targetDate?: string | null;
  sortOrder?: number;
  status?: string;
  isCheckpoint?: boolean;
  isExternal?: boolean;
  externalDependency?: string | null;
  isCriticalPath?: boolean;
  fallbackPlan?: string | null;
  firstAction?: string | null;
  progressPercent?: number;
  dependsOnResultIds?: number[];
}

export interface RecordWorkBlockInput {
  userId: number;
  action: "plan" | "start" | "complete" | "cancel";
  goalId: number;
  goalResultId?: number | null;
  workBlockId?: number;
  intention?: string;
  firstPhysicalStep?: string | null;
  plannedStartAt?: string | null;
  plannedMinutes?: number | null;
  ifThenRule?: string | null;
  completionCriterion?: string | null;
  energyBefore?: number | null;
  energyAfter?: number | null;
  actualMinutes?: number | null;
  actualResult?: string | null;
  artifact?: string | null;
  obstacle?: string | null;
  helpfulFactor?: string | null;
  nextStep?: string | null;
  resultCompleted?: boolean;
  progressPercent?: number;
}

export class GoalService {
  constructor(
    private readonly db: Database,
    private readonly runtimeContext?: RuntimeContextBuilder,
    private readonly graph?: GraphRepository,
  ) {}

  async getGoalContext(userId: number, goalId?: number): Promise<JsonObject> {
    const goalsResult = await this.db.query(
      `SELECT *
         FROM goals
        WHERE user_id = $1
          AND ($2::bigint IS NULL OR id = $2)
        ORDER BY
          CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
          priority,
          updated_at DESC`,
      [userId, goalId ?? null],
    );
    if (goalId && goalsResult.rows.length === 0) throw new Error("Цель не найдена");
    const selectedGoal = goalId
      ? goalsResult.rows[0]
      : goalsResult.rows.find((goal) => goal.status === "active") ?? goalsResult.rows[0];
    const selectedGoalId = selectedGoal ? Number(selectedGoal.id) : null;

    const [north, results, dependencies, workBlocks, reviews, recommendations, strategies, learning] =
      await Promise.all([
        this.db.query("SELECT * FROM user_north WHERE user_id = $1", [userId]),
        this.db.query(
          `SELECT * FROM goal_results
            WHERE user_id = $1 AND goal_id = $2
            ORDER BY sort_order, id`,
          [userId, selectedGoalId],
        ),
        this.db.query(
          `SELECT d.*
             FROM goal_dependencies d
             JOIN goal_results r ON r.id = d.result_id
            WHERE d.user_id = $1 AND d.goal_id = $2 AND r.user_id = $1
            ORDER BY d.id`,
          [userId, selectedGoalId],
        ),
        this.db.query(
          `SELECT * FROM work_blocks
            WHERE user_id = $1 AND goal_id = $2
            ORDER BY
              CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
              COALESCE(planned_start_at, created_at) DESC
            LIMIT 30`,
          [userId, selectedGoalId],
        ),
        this.db.query(
          `SELECT * FROM goal_reviews
            WHERE user_id = $1 AND goal_id = $2
            ORDER BY created_at DESC LIMIT 20`,
          [userId, selectedGoalId],
        ),
        this.db.query(
          `SELECT * FROM goal_recommendations
            WHERE user_id = $1 AND goal_id = $2
            ORDER BY created_at DESC LIMIT 20`,
          [userId, selectedGoalId],
        ),
        this.db.query(
          `SELECT * FROM user_strategies
            WHERE user_id = $1 AND ($2::bigint IS NULL OR goal_id = $2 OR goal_id IS NULL)
            ORDER BY status, updated_at DESC LIMIT 20`,
          [userId, selectedGoalId],
        ),
        this.db.query(
          `SELECT * FROM learning_attempts
            WHERE user_id = $1 AND goal_id = $2
            ORDER BY created_at DESC LIMIT 20`,
          [userId, selectedGoalId],
        ),
      ]);

    return {
      north: north.rows[0] ?? null,
      goals: goalsResult.rows,
      selected_goal_id: selectedGoalId,
      results: results.rows,
      dependencies: dependencies.rows,
      work_blocks: workBlocks.rows,
      reviews: reviews.rows,
      recommendations: recommendations.rows,
      strategies: strategies.rows,
      learning_attempts: learning.rows,
    };
  }

  async upsertGoal(input: UpsertGoalInput): Promise<unknown> {
    validateGoalInput(input);
    if (input.parentGoalId != null) {
      await this.requireGoal(input.userId, input.parentGoalId);
    }
    if (input.north) await this.upsertNorth(input.userId, input.north);

    if (!input.id) {
      const title = cleanRequired(input.title, "title", 500);
      if (input.status === "active") {
        throw new Error("Новую цель сначала нужно явно подтвердить через confirm_goal");
      }
      const { rows } = await this.db.query(
        `INSERT INTO goals (
           user_id, parent_goal_id, life_area, horizon, title, why_it_matters,
           result_artifact, target_date, success_criteria, minimum_version,
           target_version, constraints, learning_goal, review_condition,
           stop_condition, priority, status, vector_stage, next_review_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::date, $9::jsonb, $10,
           $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19::timestamptz
         )
         RETURNING *`,
        [
          input.userId,
          input.parentGoalId ?? null,
          cleanOptional(input.lifeArea, 200),
          cleanOptional(input.horizon, 100),
          title,
          cleanOptional(input.whyItMatters, 5_000),
          cleanOptional(input.resultArtifact, 5_000),
          input.targetDate ?? null,
          jsonText(input.successCriteria ?? []),
          cleanOptional(input.minimumVersion, 5_000),
          cleanOptional(input.targetVersion, 5_000),
          jsonText(input.constraints ?? []),
          cleanOptional(input.learningGoal, 5_000),
          cleanOptional(input.reviewCondition, 5_000),
          cleanOptional(input.stopCondition, 5_000),
          input.priority ?? 3,
          input.status ?? "draft",
          input.vectorStage ?? "north",
          input.nextReviewAt ?? null,
        ],
      );
      this.invalidate(input.userId);
      return rows[0];
    }

    const existing = await this.requireGoal(input.userId, input.id);
    if (input.status === "active" && existing.user_confirmed !== true) {
      throw new Error("Цель нельзя активировать без явного confirm_goal");
    }
    const fields: Array<{ column: string; value: unknown; cast?: string }> = [];
    addField(fields, input, "parentGoalId", "parent_goal_id");
    addField(fields, input, "lifeArea", "life_area", undefined, (value) => cleanOptional(value as string | null, 200));
    addField(fields, input, "horizon", "horizon", undefined, (value) => cleanOptional(value as string | null, 100));
    addField(fields, input, "title", "title", undefined, (value) => cleanRequired(value, "title", 500));
    addField(fields, input, "whyItMatters", "why_it_matters", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "resultArtifact", "result_artifact", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "targetDate", "target_date", "date");
    addField(fields, input, "successCriteria", "success_criteria", "jsonb", jsonText);
    addField(fields, input, "minimumVersion", "minimum_version", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "targetVersion", "target_version", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "constraints", "constraints", "jsonb", jsonText);
    addField(fields, input, "learningGoal", "learning_goal", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "reviewCondition", "review_condition", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "stopCondition", "stop_condition", undefined, (value) => cleanOptional(value as string | null, 5_000));
    addField(fields, input, "priority", "priority");
    addField(fields, input, "status", "status");
    addField(fields, input, "vectorStage", "vector_stage");
    addField(fields, input, "nextReviewAt", "next_review_at", "timestamptz");
    if (fields.length === 0) return existing;
    const values: unknown[] = [input.id, input.userId];
    const assignments = fields.map((field) => {
      values.push(field.value);
      return `${field.column} = $${values.length}${field.cast ? `::${field.cast}` : ""}`;
    });
    if (input.status === "completed") assignments.push("completed_at = COALESCE(completed_at, now())");
    const sql = `UPDATE goals SET ${assignments.join(", ")}
      WHERE id = $1 AND user_id = $2
      RETURNING *`;
    const saved = this.graph && existing.user_confirmed === true
      ? await this.db.transaction(async (client) => {
          const { rows } = await client.query(sql, values);
          const north = await client.query(
            "SELECT values, reduce_list FROM user_north WHERE user_id = $1",
            [input.userId],
          );
          if (rows[0]) {
            await this.graph!.syncGoal(client, {
              userId: input.userId,
              goal: rows[0] as Record<string, unknown>,
              values: north.rows[0]?.values,
              antiGoals: north.rows[0]?.reduce_list,
            });
          }
          return rows[0];
        })
      : (await this.db.query(sql, values)).rows[0];
    this.invalidate(input.userId);
    return saved;
  }

  async confirmGoal(userId: number, goalId: number): Promise<unknown> {
    const sql = `UPDATE goals
            SET user_confirmed = true,
                confirmed_at = COALESCE(confirmed_at, now()),
                status = 'active',
                vector_stage = CASE WHEN vector_stage = 'north' THEN 'result' ELSE vector_stage END
          WHERE id = $1 AND user_id = $2
          RETURNING *`;
    const graph = this.graph;
    const saved = graph
      ? await this.db.transaction(async (client) => {
        const { rows } = await client.query(sql, [goalId, userId]);
        if (!rows[0]) throw new Error("Цель не найдена");
        const north = await client.query(
          "SELECT values, reduce_list FROM user_north WHERE user_id = $1",
          [userId],
        );
        await graph.syncGoal(client, {
          userId,
          goal: rows[0] as Record<string, unknown>,
          values: north.rows[0]?.values,
          antiGoals: north.rows[0]?.reduce_list,
        });
        const [results, dependencies] = await Promise.all([
          client.query(
            "SELECT * FROM goal_results WHERE user_id = $1 AND goal_id = $2 ORDER BY sort_order, id",
            [userId, goalId],
          ),
          client.query<{ result_id: string; depends_on_result_id: string }>(
            `SELECT result_id, depends_on_result_id
               FROM goal_dependencies
              WHERE user_id = $1 AND goal_id = $2
                AND depends_on_result_id IS NOT NULL`,
            [userId, goalId],
          ),
        ]);
        for (const result of results.rows) {
          const resultId = Number(result.id);
          await graph.syncGoalResult(client, {
            userId,
            goalId,
            result: result as Record<string, unknown>,
            dependencyIds: dependencies.rows
              .filter((dependency) => Number(dependency.result_id) === resultId)
              .map((dependency) => Number(dependency.depends_on_result_id)),
            goalConfirmed: true,
          });
        }
        return rows[0];
      })
      : (await this.db.query(sql, [goalId, userId])).rows[0];
    if (!saved) throw new Error("Цель не найдена");
    this.invalidate(userId);
    return saved;
  }

  async upsertGoalResult(input: UpsertGoalResultInput): Promise<unknown> {
    validateResultInput(input);
    const ownedGoal = await this.requireGoal(input.userId, input.goalId);
    if (input.parentResultId != null) {
      await this.requireResult(input.userId, input.goalId, input.parentResultId);
    }

    return await this.db.transaction(async (client) => {
      let row: Record<string, unknown>;
      if (!input.id) {
        const { rows } = await client.query(
          `INSERT INTO goal_results (
             user_id, goal_id, parent_result_id, title, result_artifact,
             success_criteria, minimum_version, target_date, sort_order, status,
             is_checkpoint, is_external, external_dependency, is_critical_path,
             fallback_plan, first_action, progress_percent
           ) VALUES (
             $1, $2, $3, $4, $5, $6::jsonb, $7, $8::date, $9, $10,
             $11, $12, $13, $14, $15, $16, $17
           ) RETURNING *`,
          [
            input.userId,
            input.goalId,
            input.parentResultId ?? null,
            cleanRequired(input.title, "title", 500),
            cleanOptional(input.resultArtifact, 5_000),
            jsonText(input.successCriteria ?? []),
            cleanOptional(input.minimumVersion, 5_000),
            input.targetDate ?? null,
            input.sortOrder ?? 100,
            input.status ?? "draft",
            input.isCheckpoint ?? false,
            input.isExternal ?? false,
            cleanOptional(input.externalDependency, 2_000),
            input.isCriticalPath ?? false,
            cleanOptional(input.fallbackPlan, 5_000),
            cleanOptional(input.firstAction, 2_000),
            input.progressPercent ?? 0,
          ],
        );
        row = rows[0] as Record<string, unknown>;
      } else {
        const owned = await client.query(
          "SELECT * FROM goal_results WHERE id = $1 AND user_id = $2 AND goal_id = $3 FOR UPDATE",
          [input.id, input.userId, input.goalId],
        );
        if (!owned.rows[0]) throw new Error("Промежуточный результат не найден");
        const fields: Array<{ column: string; value: unknown; cast?: string }> = [];
        addField(fields, input, "parentResultId", "parent_result_id");
        addField(fields, input, "title", "title", undefined, (value) => cleanRequired(value, "title", 500));
        addField(fields, input, "resultArtifact", "result_artifact", undefined, (value) => cleanOptional(value as string | null, 5_000));
        addField(fields, input, "successCriteria", "success_criteria", "jsonb", jsonText);
        addField(fields, input, "minimumVersion", "minimum_version", undefined, (value) => cleanOptional(value as string | null, 5_000));
        addField(fields, input, "targetDate", "target_date", "date");
        addField(fields, input, "sortOrder", "sort_order");
        addField(fields, input, "status", "status");
        addField(fields, input, "isCheckpoint", "is_checkpoint");
        addField(fields, input, "isExternal", "is_external");
        addField(fields, input, "externalDependency", "external_dependency", undefined, (value) => cleanOptional(value as string | null, 2_000));
        addField(fields, input, "isCriticalPath", "is_critical_path");
        addField(fields, input, "fallbackPlan", "fallback_plan", undefined, (value) => cleanOptional(value as string | null, 5_000));
        addField(fields, input, "firstAction", "first_action", undefined, (value) => cleanOptional(value as string | null, 2_000));
        addField(fields, input, "progressPercent", "progress_percent");
        if (fields.length === 0) {
          row = owned.rows[0] as Record<string, unknown>;
        } else {
          const values: unknown[] = [input.id, input.userId, input.goalId];
          const assignments = fields.map((field) => {
            values.push(field.value);
            return `${field.column} = $${values.length}${field.cast ? `::${field.cast}` : ""}`;
          });
          if (input.status === "completed") assignments.push("completed_at = COALESCE(completed_at, now())");
          const updated = await client.query(
            `UPDATE goal_results SET ${assignments.join(", ")}
              WHERE id = $1 AND user_id = $2 AND goal_id = $3
              RETURNING *`,
            values,
          );
          row = updated.rows[0] as Record<string, unknown>;
        }
      }

      if (input.dependsOnResultIds !== undefined) {
        const resultId = Number(row.id);
        const dependencies = [...new Set(input.dependsOnResultIds)].filter((id) => id !== resultId);
        if (dependencies.length > 0) {
          const checked = await client.query<{ id: string }>(
            `SELECT id FROM goal_results
              WHERE user_id = $1 AND goal_id = $2 AND id = ANY($3::bigint[])`,
            [input.userId, input.goalId, dependencies],
          );
          if (checked.rows.length !== dependencies.length) {
            throw new Error("Одна из зависимостей не принадлежит этой цели пользователя");
          }
        }
        await client.query(
          "DELETE FROM goal_dependencies WHERE user_id = $1 AND goal_id = $2 AND result_id = $3",
          [input.userId, input.goalId, resultId],
        );
        for (const dependencyId of dependencies) {
          await client.query(
            `INSERT INTO goal_dependencies
               (user_id, goal_id, result_id, depends_on_result_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [input.userId, input.goalId, resultId, dependencyId],
          );
        }
      }
      await client.query(
        "UPDATE goals SET vector_stage = 'map' WHERE id = $1 AND user_id = $2 AND vector_stage IN ('north', 'result')",
        [input.goalId, input.userId],
      );
      await this.graph?.syncGoalResult(client, {
        userId: input.userId,
        goalId: input.goalId,
        result: row,
        dependencyIds: input.dependsOnResultIds,
        goalConfirmed: ownedGoal.user_confirmed === true,
      });
      return row;
    }).finally(() => this.invalidate(input.userId));
  }

  async recordWorkBlock(input: RecordWorkBlockInput): Promise<unknown> {
    validateWorkBlockInput(input);
    return await this.db.transaction(async (client) => {
      const goal = await client.query(
        "SELECT * FROM goals WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [input.goalId, input.userId],
      );
      if (!goal.rows[0]) throw new Error("Цель не найдена");
      if (goal.rows[0].user_confirmed !== true) {
        throw new Error("Действие можно записать только для подтверждённой цели");
      }
      if (input.goalResultId != null) {
        const result = await client.query(
          "SELECT id FROM goal_results WHERE id = $1 AND goal_id = $2 AND user_id = $3",
          [input.goalResultId, input.goalId, input.userId],
        );
        if (!result.rows[0]) throw new Error("Промежуточный результат не принадлежит этой цели");
      }

      if (input.action === "plan" || (input.action === "start" && !input.workBlockId)) {
        const status = input.action === "start" ? "active" : "planned";
        const { rows } = await client.query(
          `INSERT INTO work_blocks (
             user_id, goal_id, goal_result_id, intention, first_physical_step,
             planned_start_at, planned_minutes, if_then_rule,
             completion_criterion, energy_before, status, started_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10,
             $11, CASE WHEN $11 = 'active' THEN now() ELSE NULL END
           ) RETURNING *`,
          [
            input.userId,
            input.goalId,
            input.goalResultId ?? null,
            cleanRequired(input.intention, "intention", 2_000),
            cleanOptional(input.firstPhysicalStep, 2_000),
            input.plannedStartAt ?? null,
            input.plannedMinutes ?? null,
            cleanOptional(input.ifThenRule, 2_000),
            cleanOptional(input.completionCriterion, 2_000),
            input.energyBefore ?? null,
            status,
          ],
        );
        await client.query(
          "UPDATE goals SET vector_stage = 'action' WHERE id = $1 AND user_id = $2",
          [input.goalId, input.userId],
        );
        return rows[0];
      }

      if (!input.workBlockId) throw new Error("Для этой операции требуется work_block_id");
      const owned = await client.query(
        `SELECT * FROM work_blocks
          WHERE id = $1 AND user_id = $2 AND goal_id = $3
          FOR UPDATE`,
        [input.workBlockId, input.userId, input.goalId],
      );
      if (!owned.rows[0]) throw new Error("Рабочий блок не найден");

      if (input.action === "start") {
        if (!["planned", "active"].includes(String(owned.rows[0].status))) {
          throw new Error("Начать можно только запланированный рабочий блок");
        }
        const { rows } = await client.query(
          `UPDATE work_blocks
              SET status = 'active',
                  started_at = COALESCE(started_at, now()),
                  energy_before = COALESCE($4, energy_before)
            WHERE id = $1 AND user_id = $2 AND goal_id = $3
            RETURNING *`,
          [input.workBlockId, input.userId, input.goalId, input.energyBefore ?? null],
        );
        await client.query(
          "UPDATE goals SET vector_stage = 'action' WHERE id = $1 AND user_id = $2",
          [input.goalId, input.userId],
        );
        return rows[0];
      }

      if (input.action === "cancel") {
        const { rows } = await client.query(
          `UPDATE work_blocks SET status = 'canceled'
            WHERE id = $1 AND user_id = $2 AND goal_id = $3
            RETURNING *`,
          [input.workBlockId, input.userId, input.goalId],
        );
        return rows[0];
      }

      const actualResult = cleanRequired(input.actualResult, "actual_result", 10_000);
      const { rows } = await client.query(
        `UPDATE work_blocks
            SET status = 'completed',
                completed_at = now(),
                actual_minutes = COALESCE(
                  $4,
                  CASE WHEN started_at IS NOT NULL
                    THEN GREATEST(0, round(EXTRACT(EPOCH FROM (now() - started_at)) / 60)::integer)
                    ELSE NULL
                  END
                ),
                actual_result = $5,
                artifact = $6,
                obstacle = $7,
                helpful_factor = $8,
                next_step = $9,
                energy_after = $10
          WHERE id = $1 AND user_id = $2 AND goal_id = $3
          RETURNING *`,
        [
          input.workBlockId,
          input.userId,
          input.goalId,
          input.actualMinutes ?? null,
          actualResult,
          cleanOptional(input.artifact, 10_000),
          cleanOptional(input.obstacle, 5_000),
          cleanOptional(input.helpfulFactor, 5_000),
          cleanOptional(input.nextStep, 5_000),
          input.energyAfter ?? null,
        ],
      );
      const resultId =
        input.goalResultId ?? (Number(owned.rows[0].goal_result_id) || null);
      if (resultId) {
        await client.query(
          `UPDATE goal_results
              SET status = CASE WHEN $4 THEN 'completed' ELSE 'in_progress' END,
                  progress_percent = COALESCE($5, CASE WHEN $4 THEN 100 ELSE progress_percent END),
                  completed_at = CASE WHEN $4 THEN COALESCE(completed_at, now()) ELSE completed_at END
            WHERE id = $1 AND user_id = $2 AND goal_id = $3`,
          [
            resultId,
            input.userId,
            input.goalId,
            input.resultCompleted === true,
            input.progressPercent ?? null,
          ],
        );
      }
      await client.query(
        `UPDATE goals
            SET vector_stage = 'feedback', last_progress_at = now()
          WHERE id = $1 AND user_id = $2`,
        [input.goalId, input.userId],
      );
      await this.graph?.syncWorkBlockFeedback(client, {
        userId: input.userId,
        goalId: input.goalId,
        workBlock: rows[0] as Record<string, unknown>,
      });
      return rows[0];
    }).finally(() => this.invalidate(input.userId));
  }

  async recordGoalReview(input: {
    userId: number;
    goalId: number;
    workBlockId?: number | null;
    reviewType?: string;
    fact: string;
    systemSignal?: string | null;
    changedElement?: string | null;
    nextSmallStep?: string | null;
    planSnapshot?: unknown;
    factSnapshot?: unknown;
  }): Promise<unknown> {
    const reviewType = input.reviewType ?? "deviation";
    if (!REVIEW_TYPES.has(reviewType)) throw new Error("Неизвестный тип обзора цели");
    await this.requireGoal(input.userId, input.goalId);
    if (input.workBlockId != null) {
      const block = await this.db.query(
        "SELECT id FROM work_blocks WHERE id = $1 AND goal_id = $2 AND user_id = $3",
        [input.workBlockId, input.goalId, input.userId],
      );
      if (!block.rows[0]) throw new Error("Рабочий блок не принадлежит этой цели");
    }
    const review = await this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO goal_reviews (
           user_id, goal_id, work_block_id, review_type, fact, system_signal,
           changed_element, next_small_step, plan_snapshot, fact_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
         RETURNING *`,
        [
          input.userId,
          input.goalId,
          input.workBlockId ?? null,
          reviewType,
          cleanRequired(input.fact, "fact", 10_000),
          cleanOptional(input.systemSignal, 5_000),
          cleanOptional(input.changedElement, 5_000),
          cleanOptional(input.nextSmallStep, 5_000),
          jsonText(input.planSnapshot ?? {}),
          jsonText(input.factSnapshot ?? {}),
        ],
      );
      if (input.changedElement || input.nextSmallStep) {
        await client.query(
          `INSERT INTO goal_recommendations (
             user_id, goal_id, review_id, recommendation, changed_element, next_small_step
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.userId,
            input.goalId,
            rows[0].id,
            [
              cleanOptional(input.changedElement, 5_000),
              cleanOptional(input.nextSmallStep, 5_000),
            ].filter(Boolean).join(". "),
            cleanOptional(input.changedElement, 5_000),
            cleanOptional(input.nextSmallStep, 5_000),
          ],
        );
      }
      await client.query(
        "UPDATE goals SET vector_stage = 'review' WHERE id = $1 AND user_id = $2",
        [input.goalId, input.userId],
      );
      await this.graph?.syncReview(
        client,
        input.userId,
        input.goalId,
        rows[0] as Record<string, unknown>,
      );
      return rows[0];
    });
    this.invalidate(input.userId);
    return review;
  }

  private async requireGoal(userId: number, goalId: number): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query(
      "SELECT * FROM goals WHERE id = $1 AND user_id = $2",
      [goalId, userId],
    );
    if (!rows[0]) throw new Error("Цель не найдена");
    return rows[0] as Record<string, unknown>;
  }

  private async requireResult(
    userId: number,
    goalId: number,
    resultId: number,
  ): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query(
      "SELECT * FROM goal_results WHERE id = $1 AND goal_id = $2 AND user_id = $3",
      [resultId, goalId, userId],
    );
    if (!rows[0]) throw new Error("Промежуточный результат не найден");
    return rows[0] as Record<string, unknown>;
  }

  private async upsertNorth(
    userId: number,
    north: NonNullable<UpsertGoalInput["north"]>,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO user_north (
         user_id, desired_direction, why_it_matters, values, acceptable_cost,
         unacceptable_cost, conflicts, reduce_list, user_confirmed, confirmed_at
       ) VALUES (
         $1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9,
         CASE WHEN $9 THEN now() ELSE NULL END
       )
       ON CONFLICT (user_id) DO UPDATE SET
         desired_direction = COALESCE(EXCLUDED.desired_direction, user_north.desired_direction),
         why_it_matters = COALESCE(EXCLUDED.why_it_matters, user_north.why_it_matters),
         values = CASE WHEN $10 THEN EXCLUDED.values ELSE user_north.values END,
         acceptable_cost = COALESCE(EXCLUDED.acceptable_cost, user_north.acceptable_cost),
         unacceptable_cost = COALESCE(EXCLUDED.unacceptable_cost, user_north.unacceptable_cost),
         conflicts = CASE WHEN $11 THEN EXCLUDED.conflicts ELSE user_north.conflicts END,
         reduce_list = CASE WHEN $12 THEN EXCLUDED.reduce_list ELSE user_north.reduce_list END,
         user_confirmed = CASE WHEN $13 THEN EXCLUDED.user_confirmed ELSE user_north.user_confirmed END,
         confirmed_at = CASE
           WHEN $13 AND EXCLUDED.user_confirmed THEN COALESCE(user_north.confirmed_at, now())
           WHEN $13 THEN NULL
           ELSE user_north.confirmed_at
         END`,
      [
        userId,
        cleanOptional(north.desiredDirection, 5_000),
        cleanOptional(north.whyItMatters, 5_000),
        jsonText(north.values ?? []),
        cleanOptional(north.acceptableCost, 5_000),
        cleanOptional(north.unacceptableCost, 5_000),
        jsonText(north.conflicts ?? []),
        jsonText(north.reduceList ?? []),
        north.userConfirmed === true,
        Object.hasOwn(north, "values"),
        Object.hasOwn(north, "conflicts"),
        Object.hasOwn(north, "reduceList"),
        Object.hasOwn(north, "userConfirmed"),
      ],
    );
  }

  private invalidate(userId: number): void {
    this.runtimeContext?.invalidate(userId);
  }
}

function validateGoalInput(input: UpsertGoalInput): void {
  if (input.id !== undefined) positiveInteger(input.id, "id");
  if (input.parentGoalId != null) positiveInteger(input.parentGoalId, "parent_goal_id");
  if (input.id && input.parentGoalId === input.id) throw new Error("Цель не может быть родителем самой себя");
  if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)) {
    throw new Error("priority должен быть от 1 до 5");
  }
  if (input.status !== undefined && !GOAL_STATUSES.has(input.status)) throw new Error("Неизвестный статус цели");
  if (input.vectorStage !== undefined && !VECTOR_STAGES.has(input.vectorStage)) throw new Error("Неизвестный этап VECTOR");
  dateOnly(input.targetDate, "target_date");
  dateTime(input.nextReviewAt, "next_review_at");
}

function validateResultInput(input: UpsertGoalResultInput): void {
  positiveInteger(input.goalId, "goal_id");
  if (input.id !== undefined) positiveInteger(input.id, "id");
  if (input.parentResultId != null) positiveInteger(input.parentResultId, "parent_result_id");
  if (input.id && input.parentResultId === input.id) throw new Error("Результат не может зависеть от себя как от родителя");
  if (input.status !== undefined && !RESULT_STATUSES.has(input.status)) throw new Error("Неизвестный статус результата");
  if (input.progressPercent !== undefined && (!Number.isInteger(input.progressPercent) || input.progressPercent < 0 || input.progressPercent > 100)) {
    throw new Error("progress_percent должен быть от 0 до 100");
  }
  dateOnly(input.targetDate, "target_date");
  for (const id of input.dependsOnResultIds ?? []) positiveInteger(id, "depends_on_result_ids");
}

function validateWorkBlockInput(input: RecordWorkBlockInput): void {
  positiveInteger(input.goalId, "goal_id");
  if (input.goalResultId != null) positiveInteger(input.goalResultId, "goal_result_id");
  if (input.workBlockId !== undefined) positiveInteger(input.workBlockId, "work_block_id");
  boundedInteger(input.plannedMinutes, "planned_minutes", 1, 1440);
  boundedInteger(input.actualMinutes, "actual_minutes", 0, 10080);
  boundedInteger(input.energyBefore, "energy_before", 1, 5);
  boundedInteger(input.energyAfter, "energy_after", 1, 5);
  boundedInteger(input.progressPercent, "progress_percent", 0, 100);
  dateTime(input.plannedStartAt, "planned_start_at");
}

function addField(
  fields: Array<{ column: string; value: unknown; cast?: string }>,
  source: object,
  key: string,
  column: string,
  cast?: string,
  transform: (value: unknown) => unknown = (value) => value,
): void {
  if (!Object.hasOwn(source, key)) return;
  fields.push({ column, value: transform((source as JsonObject)[key]), ...(cast ? { cast } : {}) });
}

function cleanRequired(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}: требуется непустой текст`);
  return value.trim().slice(0, max);
}

function cleanOptional(value: string | null | undefined, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Ожидается текстовое значение");
  return value.trim().slice(0, max) || null;
}

function jsonText(value: unknown): string {
  if (value === undefined) return "null";
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 100_000) {
    throw new Error("JSON-значение отсутствует или слишком велико");
  }
  return serialized;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name}: требуется положительное целое число`);
}

function boundedInteger(
  value: number | null | undefined,
  name: string,
  min: number,
  max: number,
): void {
  if (value == null) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}: ожидается целое число от ${min} до ${max}`);
  }
}

function dateOnly(value: string | null | undefined, name: string): void {
  if (value == null || value === "") return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${name}: ожидается дата YYYY-MM-DD`);
  }
}

function dateTime(value: string | null | undefined, name: string): void {
  if (value == null || value === "") return;
  if (Number.isNaN(Date.parse(value))) throw new Error(`${name}: ожидается дата и время ISO 8601`);
}
