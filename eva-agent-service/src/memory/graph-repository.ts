import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import type { Database } from "../db.js";
import type { ProfileField } from "../profile/profile-service.js";

export type GraphNodeType =
  | "profile_fact"
  | "interest"
  | "value"
  | "anti_goal"
  | "goal"
  | "goal_result"
  | "task"
  | "person"
  | "relationship"
  | "event"
  | "obstacle"
  | "strategy"
  | "psychological_feature"
  | "artifact"
  | "review"
  | "decision";

export type GraphNodeStatus =
  | "active"
  | "unconfirmed"
  | "disputed"
  | "superseded"
  | "archived";

export type GraphRelationType =
  | "belongs_to"
  | "aligned_with"
  | "constrained_by"
  | "part_of"
  | "depends_on"
  | "advances"
  | "blocks"
  | "helps_with"
  | "effective_for"
  | "uses"
  | "produced_by"
  | "evaluates"
  | "involves"
  | "supports";

export interface MemoryNodeRow extends QueryResultRow {
  id: string;
  user_id: string;
  node_type: GraphNodeType;
  canonical_key: string;
  title: string;
  text_content: string | null;
  content_json: Record<string, unknown>;
  status: GraphNodeStatus;
  confidence: string;
  sensitivity: "normal" | "sensitive" | "high";
  source_type: string;
  source_id: string | null;
  source_quote: string | null;
  updated_at: Date;
}

export interface GraphQueryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export class GraphRepository {
  constructor(private readonly db: Database) {}

  async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return await this.db.transaction(work);
  }

  async upsertNode(
    queryable: GraphQueryable,
    input: {
      userId: number;
      nodeType: GraphNodeType;
      canonicalKey: string;
      title: string;
      textContent?: string | null;
      contentJson?: unknown;
      status?: GraphNodeStatus;
      confidence: number;
      sensitivity?: "normal" | "sensitive" | "high";
      sourceType: string;
      sourceId?: string | null;
      sourceQuote?: string | null;
    },
  ): Promise<MemoryNodeRow> {
    const { rows } = await queryable.query<MemoryNodeRow>(
      `INSERT INTO memory_nodes (
         user_id, node_type, canonical_key, title, text_content, content_json,
         status, confidence, sensitivity, source_type, source_id, source_quote,
         valid_from
       ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, now()
       )
       ON CONFLICT (user_id, node_type, canonical_key) DO UPDATE SET
         title = EXCLUDED.title,
         text_content = EXCLUDED.text_content,
         content_json = EXCLUDED.content_json,
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence,
         sensitivity = EXCLUDED.sensitivity,
         source_type = EXCLUDED.source_type,
         source_id = EXCLUDED.source_id,
         source_quote = EXCLUDED.source_quote,
         valid_from = CASE
           WHEN memory_nodes.status <> EXCLUDED.status THEN now()
           ELSE memory_nodes.valid_from
         END,
         valid_to = CASE
           WHEN EXCLUDED.status IN ('superseded', 'archived') THEN now()
           ELSE NULL
         END
       RETURNING *`,
      [
        input.userId,
        input.nodeType,
        clean(input.canonicalKey, 500),
        clean(input.title, 500),
        cleanOptional(input.textContent, 10_000),
        jsonText(input.contentJson ?? {}),
        input.status ?? "active",
        clamp(input.confidence),
        input.sensitivity ?? "normal",
        clean(input.sourceType, 100),
        cleanOptional(input.sourceId, 300),
        cleanOptional(input.sourceQuote, 2_000),
      ],
    );
    return rows[0]!;
  }

  async upsertEdge(
    queryable: GraphQueryable,
    input: {
      userId: number;
      fromNodeId: number;
      relationType: GraphRelationType;
      toNodeId: number;
      weight?: number;
      confidence: number;
      status?: "active" | "disputed" | "archived";
      sourceType: string;
      sourceId?: string | null;
    },
  ): Promise<void> {
    if (input.fromNodeId === input.toNodeId) return;
    await queryable.query(
      `INSERT INTO memory_edges (
         user_id, from_node_id, relation_type, to_node_id, weight, confidence,
         status, source_type, source_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, from_node_id, relation_type, to_node_id)
       DO UPDATE SET
         weight = EXCLUDED.weight,
         confidence = EXCLUDED.confidence,
         status = EXCLUDED.status,
         source_type = EXCLUDED.source_type,
         source_id = EXCLUDED.source_id`,
      [
        input.userId,
        input.fromNodeId,
        input.relationType,
        input.toNodeId,
        Math.min(Math.max(input.weight ?? 1, 0), 100),
        clamp(input.confidence),
        input.status ?? "active",
        clean(input.sourceType, 100),
        cleanOptional(input.sourceId, 300),
      ],
    );
  }

  async syncProfile(
    queryable: GraphQueryable,
    userId: number,
    field: ProfileField,
  ): Promise<void> {
    const confidence = clamp(Number(field.confidence ?? (field.status === "confirmed" ? 1 : 0.7)));
    const status = profileStatus(field.status);
    const sourceType = field.source_type ?? "profile";
    const sourceId = field.source_id ?? field.field_key;
    const root = await this.userRoot(queryable, userId, sourceType);
    if (field.field_key === "interests") {
      const values = Array.isArray(field.field_json)
        ? field.field_json.filter((item): item is string => typeof item === "string")
        : [];
      const canonicalKeys = values.map((value) => `interest:${canonical(value)}`);
      await queryable.query(
        `UPDATE memory_nodes
            SET status = 'superseded', valid_to = now()
          WHERE user_id = $1
            AND node_type = 'interest'
            AND content_json->>'profile_field' = $2
            AND NOT (canonical_key = ANY($3::text[]))`,
        [userId, field.field_key, canonicalKeys],
      );
      for (const value of values) {
        const node = await this.upsertNode(queryable, {
          userId,
          nodeType: "interest",
          canonicalKey: `interest:${canonical(value)}`,
          title: value,
          textContent: value,
          contentJson: { profile_field: field.field_key, source_id: field.source_id },
          status,
          confidence,
          sourceType,
          sourceId,
          sourceQuote: field.source_quote,
        });
        await this.upsertEdge(queryable, {
          userId,
          fromNodeId: Number(node.id),
          relationType: "belongs_to",
          toNodeId: Number(root.id),
          confidence,
          sourceType,
          sourceId,
        });
      }
      return;
    }

    const value = field.field_value ?? (
      field.field_json == null ? "" : JSON.stringify(field.field_json)
    );
    const node = await this.upsertNode(queryable, {
      userId,
      nodeType: field.sensitivity === "normal" ? "profile_fact" : "psychological_feature",
      canonicalKey: `profile:${field.field_key}`,
      title: field.field_key,
      textContent: value,
      contentJson: { profile_field: field.field_key, value: field.field_json },
      status,
      confidence,
      sensitivity: field.sensitivity,
      sourceType,
      sourceId,
      sourceQuote: field.source_quote,
    });
    await this.upsertEdge(queryable, {
      userId,
      fromNodeId: Number(node.id),
      relationType: "belongs_to",
      toNodeId: Number(root.id),
      confidence,
      sourceType,
      sourceId,
    });
  }

  async syncGoal(
    queryable: GraphQueryable,
    input: {
      userId: number;
      goal: Record<string, unknown>;
      values?: unknown;
      antiGoals?: unknown;
    },
  ): Promise<void> {
    const goalId = Number(input.goal.id);
    const sourceId = String(goalId);
    const goalNode = await this.upsertNode(queryable, {
      userId: input.userId,
      nodeType: "goal",
      canonicalKey: `goal:${goalId}`,
      title: String(input.goal.title ?? "Цель"),
      textContent: [
        input.goal.why_it_matters,
        input.goal.result_artifact,
        input.goal.minimum_version,
      ].filter((value): value is string => typeof value === "string" && Boolean(value)).join(". "),
      contentJson: {
        target_date: input.goal.target_date ?? null,
        success_criteria: input.goal.success_criteria ?? [],
        constraints: input.goal.constraints ?? [],
      },
      status: input.goal.user_confirmed === true ? "active" : "unconfirmed",
      confidence: input.goal.user_confirmed === true ? 1 : 0.7,
      sourceType: "goal",
      sourceId,
    });
    for (const value of stringValues(input.values)) {
      const valueNode = await this.upsertNode(queryable, {
        userId: input.userId,
        nodeType: "value",
        canonicalKey: `value:${canonical(value)}`,
        title: value,
        textContent: value,
        confidence: 1,
        sourceType: "goal",
        sourceId,
      });
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(goalNode.id),
        relationType: "aligned_with",
        toNodeId: Number(valueNode.id),
        confidence: 1,
        sourceType: "goal",
        sourceId,
      });
    }
    for (const antiGoal of stringValues(input.antiGoals)) {
      const antiNode = await this.upsertNode(queryable, {
        userId: input.userId,
        nodeType: "anti_goal",
        canonicalKey: `anti-goal:${canonical(antiGoal)}`,
        title: antiGoal,
        textContent: antiGoal,
        confidence: 1,
        sourceType: "goal",
        sourceId,
      });
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(goalNode.id),
        relationType: "constrained_by",
        toNodeId: Number(antiNode.id),
        confidence: 1,
        sourceType: "goal",
        sourceId,
      });
    }
  }

  async syncGoalResult(
    queryable: GraphQueryable,
    input: {
      userId: number;
      goalId: number;
      result: Record<string, unknown>;
      dependencyIds?: number[];
      goalConfirmed?: boolean;
    },
  ): Promise<void> {
    const resultId = Number(input.result.id);
    const resultNode = await this.upsertNode(queryable, {
      userId: input.userId,
      nodeType: "goal_result",
      canonicalKey: `goal-result:${resultId}`,
      title: String(input.result.title ?? "Результат"),
      textContent: [
        input.result.result_artifact,
        input.result.first_action,
      ].filter((value): value is string => typeof value === "string" && Boolean(value)).join(". "),
      contentJson: {
        success_criteria: input.result.success_criteria ?? [],
        progress_percent: input.result.progress_percent ?? 0,
      },
      status: input.goalConfirmed === false
        ? "unconfirmed"
        : input.result.status === "completed"
          ? "archived"
          : "active",
      confidence: 1,
      sourceType: "goal_result",
      sourceId: String(resultId),
    });
    const goalNode = await this.nodeByCanonical(
      queryable,
      input.userId,
      "goal",
      `goal:${input.goalId}`,
    );
    if (goalNode) {
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(resultNode.id),
        relationType: "part_of",
        toNodeId: Number(goalNode.id),
        confidence: 1,
        sourceType: "goal_result",
        sourceId: String(resultId),
      });
    }
    for (const dependencyId of input.dependencyIds ?? []) {
      const dependency = await this.nodeByCanonical(
        queryable,
        input.userId,
        "goal_result",
        `goal-result:${dependencyId}`,
      );
      if (!dependency) continue;
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(resultNode.id),
        relationType: "depends_on",
        toNodeId: Number(dependency.id),
        confidence: 1,
        sourceType: "goal_result",
        sourceId: String(resultId),
      });
    }
  }

  async syncTask(
    queryable: GraphQueryable,
    input: {
      userId: number;
      task: Record<string, unknown>;
      goalResultId?: number | null;
    },
  ): Promise<void> {
    const taskId = Number(input.task.id);
    const taskNode = await this.upsertNode(queryable, {
      userId: input.userId,
      nodeType: "task",
      canonicalKey: `task:${taskId}`,
      title: String(input.task.title ?? "Задача"),
      textContent: typeof input.task.description === "string" ? input.task.description : null,
      contentJson: {
        due_at: input.task.due_at ?? null,
        status: input.task.status ?? "open",
      },
      confidence: 1,
      sourceType: "task",
      sourceId: String(taskId),
    });
    if (!input.goalResultId) return;
    const resultNode = await this.nodeByCanonical(
      queryable,
      input.userId,
      "goal_result",
      `goal-result:${input.goalResultId}`,
    );
    if (!resultNode) return;
    await this.upsertEdge(queryable, {
      userId: input.userId,
      fromNodeId: Number(taskNode.id),
      relationType: "advances",
      toNodeId: Number(resultNode.id),
      confidence: 1,
      sourceType: "task",
      sourceId: String(taskId),
    });
  }

  async syncWorkBlockFeedback(
    queryable: GraphQueryable,
    input: {
      userId: number;
      goalId: number;
      workBlock: Record<string, unknown>;
    },
  ): Promise<void> {
    const blockId = Number(input.workBlock.id);
    const eventNode = await this.upsertNode(queryable, {
      userId: input.userId,
      nodeType: "event",
      canonicalKey: `work-block:${blockId}`,
      title: String(input.workBlock.intention ?? "Рабочий блок"),
      textContent: typeof input.workBlock.actual_result === "string"
        ? input.workBlock.actual_result
        : null,
      contentJson: {
        actual_minutes: input.workBlock.actual_minutes ?? null,
        next_step: input.workBlock.next_step ?? null,
      },
      confidence: 1,
      sourceType: "work_block",
      sourceId: String(blockId),
    });
    const goalNode = await this.nodeByCanonical(
      queryable,
      input.userId,
      "goal",
      `goal:${input.goalId}`,
    );
    const artifactText = textValue(input.workBlock.artifact);
    if (artifactText) {
      const artifactNode = await this.upsertNode(queryable, {
        userId: input.userId,
        nodeType: "artifact",
        canonicalKey: `work-block-artifact:${blockId}`,
        title: artifactText.slice(0, 200),
        textContent: artifactText,
        confidence: 1,
        sourceType: "work_block",
        sourceId: String(blockId),
      });
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(artifactNode.id),
        relationType: "produced_by",
        toNodeId: Number(eventNode.id),
        confidence: 1,
        sourceType: "work_block",
        sourceId: String(blockId),
      });
    }
    const obstacleText = textValue(input.workBlock.obstacle);
    let obstacleNode: MemoryNodeRow | null = null;
    if (obstacleText && goalNode) {
      obstacleNode = await this.upsertNode(queryable, {
        userId: input.userId,
        nodeType: "obstacle",
        canonicalKey: `obstacle:${canonical(obstacleText)}`,
        title: obstacleText.slice(0, 200),
        textContent: obstacleText,
        confidence: 0.9,
        sourceType: "work_block",
        sourceId: String(blockId),
      });
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(obstacleNode.id),
        relationType: "blocks",
        toNodeId: Number(goalNode.id),
        confidence: 0.9,
        sourceType: "work_block",
        sourceId: String(blockId),
      });
    }
    const helpfulText = textValue(input.workBlock.helpful_factor);
    if (helpfulText) {
      const strategyNode = await this.upsertNode(queryable, {
        userId: input.userId,
        nodeType: "strategy",
        canonicalKey: `strategy:${canonical(helpfulText)}`,
        title: helpfulText.slice(0, 200),
        textContent: helpfulText,
        confidence: 0.8,
        sourceType: "work_block",
        sourceId: String(blockId),
      });
      const root = await this.userRoot(queryable, input.userId, "work_block");
      await this.upsertEdge(queryable, {
        userId: input.userId,
        fromNodeId: Number(strategyNode.id),
        relationType: "effective_for",
        toNodeId: Number(root.id),
        weight: 1,
        confidence: 0.8,
        sourceType: "work_block",
        sourceId: String(blockId),
      });
      if (obstacleNode) {
        await this.upsertEdge(queryable, {
          userId: input.userId,
          fromNodeId: Number(strategyNode.id),
          relationType: "helps_with",
          toNodeId: Number(obstacleNode.id),
          confidence: 0.8,
          sourceType: "work_block",
          sourceId: String(blockId),
        });
      }
    }
  }

  async syncReview(
    queryable: GraphQueryable,
    userId: number,
    goalId: number,
    review: Record<string, unknown>,
  ): Promise<void> {
    const reviewId = Number(review.id);
    const reviewNode = await this.upsertNode(queryable, {
      userId,
      nodeType: "review",
      canonicalKey: `review:${reviewId}`,
      title: String(review.review_type ?? "Обзор цели"),
      textContent: [
        review.fact,
        review.system_signal,
        review.changed_element,
        review.next_small_step,
      ].filter((value): value is string => typeof value === "string" && Boolean(value)).join(". "),
      confidence: 1,
      sourceType: "goal_review",
      sourceId: String(reviewId),
    });
    const goalNode = await this.nodeByCanonical(queryable, userId, "goal", `goal:${goalId}`);
    if (!goalNode) return;
    await this.upsertEdge(queryable, {
      userId,
      fromNodeId: Number(reviewNode.id),
      relationType: "evaluates",
      toNodeId: Number(goalNode.id),
      confidence: 1,
      sourceType: "goal_review",
      sourceId: String(reviewId),
    });
  }

  private async userRoot(
    queryable: GraphQueryable,
    userId: number,
    sourceType: string,
  ): Promise<MemoryNodeRow> {
    return await this.upsertNode(queryable, {
      userId,
      nodeType: "profile_fact",
      canonicalKey: "user:self",
      title: "Пользователь",
      textContent: null,
      confidence: 1,
      sourceType,
      sourceId: String(userId),
    });
  }

  private async nodeByCanonical(
    queryable: GraphQueryable,
    userId: number,
    nodeType: GraphNodeType,
    canonicalKey: string,
  ): Promise<MemoryNodeRow | null> {
    const { rows } = await queryable.query<MemoryNodeRow>(
      `SELECT * FROM memory_nodes
        WHERE user_id = $1 AND node_type = $2 AND canonical_key = $3`,
      [userId, nodeType, canonicalKey],
    );
    return rows[0] ?? null;
  }
}

function profileStatus(status: ProfileField["status"]): GraphNodeStatus {
  if (status === "confirmed") return "active";
  if (status === "candidate" || status === "missing") return "unconfirmed";
  if (status === "superseded") return "superseded";
  return "archived";
}

function stringValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => clean(item, 500))
    .filter(Boolean)
    .slice(0, 50);
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 10_000) : null;
}

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 300) || "unknown";
}

function clean(value: string, max: number): string {
  const result = value.replace(/\s+/g, " ").trim().slice(0, max);
  if (!result) throw new Error("Пустое значение графовой памяти");
  return result;
}

function cleanOptional(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function jsonText(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 100_000) return "{}";
  return serialized;
}
