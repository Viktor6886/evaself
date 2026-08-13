import type { AgentJobOutcome, AgentJobRunner, AgentJobSpec, ProposalParse } from "../jobs/agent-job.js";
import type { JobEnvelopeInput } from "../jobs/envelope.js";
import { dedupKey } from "../jobs/policy.js";
import { parseCuratorResult } from "../memory/curator/schema.js";

export const SUBAGENT_JOB_TYPE = "bounded_subagent";
export type SubagentName = "memory_reflection" | "memory_diagnostics" | "history_search" | "knowledge_search" | "document_analysis" | "goal_review" | "safety_check";
export interface SubagentDefinition { modelPolicy: "economy" | "auto" | "quality"; systemPromptRef: string; tools: readonly string[]; skills: readonly string[]; memoryScopes: readonly string[]; execution: "background"; access: "read_only" | "candidate_write"; maxInputTokens: number; maxOutputTokens: number; timeoutMs: number; maxCostMicros: number; retries: number; resultSchema: "bounded_subagent_result_v1" | "curator_result_v1" }
const define = (name: SubagentName, scopes: string[], access: SubagentDefinition["access"] = "read_only"): SubagentDefinition => ({ modelPolicy: "economy", systemPromptRef: `subagent/${name}`, tools: [], skills: [], memoryScopes: scopes, execution: "background", access, maxInputTokens: 2500, maxOutputTokens: 700, timeoutMs: 45_000, maxCostMicros: 20_000, retries: 1, resultSchema: name === "memory_reflection" ? "curator_result_v1" : "bounded_subagent_result_v1" });
export const SUBAGENTS: Readonly<Record<SubagentName, SubagentDefinition>> = Object.freeze({ memory_reflection: define("memory_reflection", ["highlights", "evidence"], "candidate_write"), memory_diagnostics: define("memory_diagnostics", ["memory_metadata"]), history_search: define("history_search", ["highlights"]), knowledge_search: define("knowledge_search", ["knowledge"]), document_analysis: define("document_analysis", ["document"]), goal_review: define("goal_review", ["goals"]), safety_check: define("safety_check", ["safety"]) });
export interface TrustedSubagentContext { kind: "job_runtime"; parentKind: "interactive"; tenantUserId: number; attempt: number }
export interface SubagentInput { userId: number; agentId: string; parentConversationId: string; messageRefs: string[]; memoryScopes: string[]; requestedTools?: string[]; context: TrustedSubagentContext }
export type PublicSubagentResult = { status: AgentJobOutcome["status"]; result: Record<string, unknown> | null; evidence: string[]; warnings: string[]; cost: { inputTokens: number; outputTokens: number; durationMs: number; costMicros: number; attempts: number } };
export type PromptResolver = (ref: string, subject: string) => Promise<string>;

export class SubagentCoordinator {
  constructor(private runner: Pick<AgentJobRunner, "run">, private resolvePrompt: PromptResolver = async (ref) => ref) {}
  async run(name: SubagentName, input: SubagentInput, signal: AbortSignal): Promise<PublicSubagentResult> {
    const d = SUBAGENTS[name];
    if (!d) throw new Error("subagent not allowed");
    if (input.context.kind !== "job_runtime" || input.context.parentKind !== "interactive") throw new Error("recursive subagent denied");
    if (input.context.tenantUserId !== input.userId) throw new Error("cross tenant denied");
    if (input.memoryScopes.some((x) => !d.memoryScopes.includes(x))) throw new Error("memory scope denied");
    if ((input.requestedTools ?? []).some((x) => !d.tools.includes(x))) throw new Error("tool denied");
    const instruction = await this.resolvePrompt(d.systemPromptRef, String(input.userId));
    const parseResult: ((reply: string) => ProposalParse) | undefined = d.resultSchema === "curator_result_v1" ? (reply) => {
      const parsed = parseCuratorResult(reply);
      return parsed.ok ? { ok: true, proposal: { kind: name, empty: parsed.result.empty, items: [], confidence: 1, payload: parsed.result as unknown as Record<string, unknown> } } : parsed;
    } : undefined;
    const spec: AgentJobSpec = { jobType: `subagent_${name}`, purpose: "maintenance", budget: { maxInputTokens: d.maxInputTokens, maxOutputTokens: d.maxOutputTokens, maxDurationMs: d.timeoutMs, maxCostMicros: d.maxCostMicros }, instruction, resultKinds: [name], maxItems: 8, parseResult, modelPolicy: d.modelPolicy, allowedTools: d.tools, allowedSkills: d.skills, memoryScopes: d.memoryScopes };
    const outcome = await this.runner.run({ runId: `subagent:${name}:${input.userId}:${input.messageRefs.join(",")}`, userId: input.userId, agentId: input.agentId, parentConversationId: input.parentConversationId, spec, signal, facts: { message_count: input.messageRefs.length } });
    const usage = outcome.usage;
    return { status: outcome.status, result: outcome.status === "succeeded" ? outcome.proposal as unknown as Record<string, unknown> : null, evidence: outcome.status === "succeeded" ? outcome.proposal.items.map((x) => x.ref).filter((x): x is string => Boolean(x)) : [], warnings: "code" in outcome ? [outcome.code] : [], cost: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, durationMs: usage.durationMs, costMicros: usage.costMicros, attempts: input.context.attempt } };
  }
}
export function reflectionTrigger(x: { episodeCompleted: boolean; substantiveMessages: number; simple: boolean }): boolean { return !x.simple && (x.episodeCompleted || (x.substantiveMessages >= 8 && x.substantiveMessages <= 15)); }
export function reflectionIntent(input: { userId: number; conversationId: string; agentId?: string | null; episodeId: number; traceId: string }): JobEnvelopeInput { return { type: SUBAGENT_JOB_TYPE, queue: "memory", idempotencyKey: `${SUBAGENT_JOB_TYPE}:${input.userId}:${input.episodeId}`, traceId: input.traceId, userId: input.userId, conversationId: input.conversationId, agentId: input.agentId ?? null, payload: { episode_id: input.episodeId, subagent: "memory_reflection" }, dedupKey: dedupKey({ mode: "keep_last_if_active", queue: "memory", type: SUBAGENT_JOB_TYPE, userId: input.userId }), dedupMode: "keep_last_if_active", deadlineMs: 120_000, privacy: "restricted" }; }
