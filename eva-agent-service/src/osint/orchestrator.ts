/**
 * Оркестратор OSINT-исследования.
 *
 * Итеративное расширение: идентификаторы запроса лежат в очереди
 * (`osint_frontier`) на глубине 0; каждый обрабатывается подходящими
 * сборщиками, а найденные ими новые идентификаторы встают в очередь на
 * глубину больше. Остановка — по бюджету, а не по «нашлось достаточно»:
 * глубина, число идентификаторов и сущностей, число внешних запросов и
 * время заданы заранее и не превышаются.
 *
 * Всё состояние — в PostgreSQL. Повтор задания после сбоя продолжает с
 * того же места: завершённый прогон сборщика по той же цели не
 * запускается второй раз, найденный идентификатор не встаёт в очередь
 * дважды, доказательство с тем же отпечатком не дублируется.
 *
 * Решение о тождестве выносит `resolver.ts`. Найденный аккаунт
 * сравнивается с субъектом исследования по признакам с доказательствами;
 * без сильного признака он остаётся «возможным», а не становится
 * аккаунтом человека.
 *
 * Данные третьих лиц не попадают ни в memory blocks Letta, ни в журналы:
 * в журнал идут только счётчики.
 */

import { claimStatus, SOURCE_TIER_QUALITY } from "./confidence.js";
import type { Collector, CollectedSource, CollectorOutput, Finding, FrontierItem } from "./collectors.js";
import { normalizeIdentifier, type NormalizedIdentifier } from "./identifiers.js";
import { decideMatch, type MatchDecision, type MatchFeature } from "./resolver.js";
import type { ClaimStatus, CollectorStatus, DegradedReason, Evidence, InvestigationBudget } from "./types.js";

export interface RunResult {
  status: Extract<CollectorStatus, "succeeded" | "degraded" | "failed" | "skipped">;
  degradedReason?: DegradedReason;
  errorCode?: string;
  externalRequests: number;
}

/** Хранилище одного исследования. Реализация — `repository.ts`. */
export interface OsintStore {
  /** Взять исследование в работу. `null` — отменено или уже завершено. */
  begin(): Promise<{ budget: InvestigationBudget; subjectEntityId: string | null } | null>;
  isCancelled(): Promise<boolean>;
  counters(): Promise<{ externalRequests: number; identifiers: number; entities: number }>;
  nextFrontier(maxDepth: number): Promise<FrontierItem | null>;
  finishFrontier(identifierId: string, status: "done" | "skipped"): Promise<void>;
  /** `null` — прогон этим сборщиком по этой цели уже завершён. */
  startRun(collector: string, identifierId: string): Promise<string | null>;
  finishRun(runId: string, result: RunResult): Promise<void>;
  saveSource(collector: string, source: CollectedSource): Promise<string>;
  saveEvidence(sourceId: string, evidence: Evidence): Promise<string>;
  upsertIdentifier(identifier: NormalizedIdentifier): Promise<string>;
  upsertAccount(url: string, identifierId: string): Promise<{ entityId: string; created: boolean }>;
  linkIdentifier(input: {
    entityId: string;
    identifierId: string;
    evidenceId: string;
    collector: string;
    confidence: number;
  }): Promise<void>;
  addClaim(input: {
    entityId: string;
    property: string;
    value: string;
    evidenceId: string;
    collector: string;
    confidence: number;
    status: ClaimStatus;
    retrievedAt: string;
  }): Promise<void>;
  recordMatch(leftEntityId: string, rightEntityId: string, decision: MatchDecision): Promise<void>;
  /** `true` — идентификатор встал в очередь впервые. */
  enqueue(identifierId: string, depth: number, runId: string): Promise<boolean>;
  complete(status: "completed" | "failed" | "cancelled", errorCode?: string): Promise<void>;
}

export interface InvestigationSummary {
  status: "completed" | "cancelled" | "not_runnable";
  processed: number;
  runs: number;
  sources: number;
  accounts: number;
  discovered: number;
  externalRequests: number;
  degradedRuns: number;
  failedRuns: number;
  stoppedBy: "frontier_empty" | "budget_requests" | "budget_runtime" | "cancelled" | null;
}

/**
 * Уверенность в принадлежности адреса аккаунту.
 *
 * Считается по тому, сколько независимых сборщиков подтвердили профиль.
 * «Не найден» у другого сборщика снижает её: противоречие видно в
 * данных, а находка не выбрасывается молча.
 */
export function accountConfidence(finding: Extract<Finding, { kind: "account" }>): number {
  if (finding.contradictedBy.length > 0) return 0.3;
  return Math.min(0.9, 0.45 + 0.15 * finding.confirmedBy.length);
}

export class OsintOrchestrator {
  constructor(
    private readonly store: OsintStore,
    private readonly collectors: readonly Collector[],
    private readonly options: { now?: () => number } = {},
  ) {}

  async run(signal: AbortSignal): Promise<InvestigationSummary> {
    const summary: InvestigationSummary = {
      status: "completed",
      processed: 0,
      runs: 0,
      sources: 0,
      accounts: 0,
      discovered: 0,
      externalRequests: 0,
      degradedRuns: 0,
      failedRuns: 0,
      stoppedBy: null,
    };
    const state = await this.store.begin();
    if (!state) return { ...summary, status: "not_runnable" };
    const { budget, subjectEntityId } = state;
    const now = this.options.now ?? Date.now;
    const deadline = now() + budget.maxRuntimeMs;

    for (;;) {
      signal.throwIfAborted();
      if (await this.store.isCancelled()) {
        summary.status = "cancelled";
        summary.stoppedBy = "cancelled";
        return summary;
      }
      if (now() >= deadline) {
        summary.stoppedBy = "budget_runtime";
        break;
      }
      const counters = await this.store.counters();
      summary.externalRequests = counters.externalRequests;
      if (counters.externalRequests >= budget.maxExternalRequests) {
        summary.stoppedBy = "budget_requests";
        break;
      }
      const item = await this.store.nextFrontier(budget.maxDepth);
      if (!item) {
        summary.stoppedBy = "frontier_empty";
        break;
      }
      summary.processed += 1;
      const applicable = this.collectors.filter((collector) => collector.accepts(item.type));
      for (const collector of applicable) {
        signal.throwIfAborted();
        const used = (await this.store.counters()).externalRequests;
        const remaining = budget.maxExternalRequests - used;
        const runId = await this.store.startRun(collector.name, item.identifierId);
        if (!runId) continue;
        summary.runs += 1;
        let output: CollectorOutput;
        try {
          output = await collector.collect({ target: item, signal, remainingRequests: remaining });
        } catch (error) {
          if (signal.aborted) throw error;
          // Сбой одного сборщика — отказ этого прогона, а не исследования.
          const raw = (error as { code?: unknown } | null)?.code;
          const code = typeof raw === "string" && /^[a-z0-9_]{3,64}$/.test(raw) ? raw : "osint_collector_error";
          summary.failedRuns += 1;
          await this.store.finishRun(runId, { status: "failed", errorCode: code, externalRequests: 0 });
          continue;
        }
        const saved = await this.persist(collector.name, runId, item, output, subjectEntityId, budget);
        summary.sources += saved.sources;
        summary.accounts += saved.accounts;
        summary.discovered += saved.discovered;
        if (output.status === "degraded") summary.degradedRuns += 1;
        if (output.status === "failed") summary.failedRuns += 1;
        await this.store.finishRun(runId, {
          status: output.status,
          ...(output.degradedReason ? { degradedReason: output.degradedReason } : {}),
          ...(output.errorCode ? { errorCode: output.errorCode } : {}),
          externalRequests: output.externalRequests,
        });
      }
      await this.store.finishFrontier(item.identifierId, applicable.length > 0 ? "done" : "skipped");
    }
    summary.externalRequests = (await this.store.counters()).externalRequests;
    await this.store.complete("completed");
    return summary;
  }

  private async persist(
    collector: string,
    runId: string,
    target: FrontierItem,
    output: CollectorOutput,
    subjectEntityId: string | null,
    budget: InvestigationBudget,
  ): Promise<{ sources: number; accounts: number; discovered: number }> {
    let accounts = 0;
    let discovered = 0;
    const accountsByUrl = new Map<string, string>();
    for (const source of output.sources) {
      const sourceId = await this.store.saveSource(collector, source);
      const quality = SOURCE_TIER_QUALITY[source.tier];
      // Сначала аккаунты: найденный рядом идентификатор привязывается к
      // своему профилю, если профиль из того же источника.
      const ordered = [...source.findings].sort((left, right) =>
        Number(left.kind !== "account") - Number(right.kind !== "account"));
      for (const finding of ordered) {
        const evidenceId = await this.store.saveEvidence(sourceId, finding.evidence);
        if (finding.kind === "account") {
          const entityId = await this.saveAccount(collector, source, finding, evidenceId, subjectEntityId, target, budget);
          if (entityId) {
            accountsByUrl.set(finding.url, entityId);
            accounts += 1;
          }
        } else if (finding.kind === "discovered") {
          const identifierId = await this.store.upsertIdentifier(finding.identifier);
          const owner = finding.accountUrl ? accountsByUrl.get(finding.accountUrl) : undefined;
          if (owner) {
            await this.store.linkIdentifier({
              entityId: owner,
              identifierId,
              evidenceId,
              collector,
              confidence: Math.min(quality, 0.6),
            });
          }
          const counters = await this.store.counters();
          const depth = target.depth + 1;
          if (depth <= budget.maxDepth && counters.identifiers < budget.maxIdentifiers
            && await this.store.enqueue(identifierId, depth, runId)) {
            discovered += 1;
          }
        }
      }
    }
    return { sources: output.sources.length, accounts, discovered };
  }

  private async saveAccount(
    collector: string,
    source: CollectedSource,
    finding: Extract<Finding, { kind: "account" }>,
    evidenceId: string,
    subjectEntityId: string | null,
    target: FrontierItem,
    budget: InvestigationBudget,
  ): Promise<string | null> {
    const identifier = normalizeIdentifier("social_account", finding.url) ?? normalizeIdentifier("url", finding.url);
    if (!identifier) return null;
    const identifierId = await this.store.upsertIdentifier(identifier);
    const counters = await this.store.counters();
    if (counters.entities >= budget.maxEntities) return null;
    const { entityId } = await this.store.upsertAccount(identifier.normalized, identifierId);
    await this.store.linkIdentifier({
      entityId,
      identifierId,
      evidenceId,
      collector,
      confidence: accountConfidence(finding),
    });
    const sourceRef = [{ sourceTier: source.tier, sourceDomain: source.domain }];
    for (const { property, value } of finding.properties) {
      await this.store.addClaim({
        entityId,
        property,
        value,
        evidenceId,
        collector,
        confidence: SOURCE_TIER_QUALITY[source.tier],
        status: claimStatus(sourceRef, false),
        retrievedAt: source.retrievedAt,
      });
    }
    if (subjectEntityId && subjectEntityId !== entityId) {
      // Совпадение username — единственное, что известно на этом шаге.
      // Resolver не поднимет такую пару выше «возможно» без сильного
      // признака: одинаковый ник у разных людей — обычное дело.
      const features: MatchFeature[] = target.type === "username"
        ? [{ kind: "exact_username", evidenceIds: [evidenceId] }]
        : [];
      const decision = decideMatch(features);
      // «rejected» без единого признака «против» значит «данных мало», а
      // не «это другой человек». Такое решение не записывается: иначе
      // отчёт показал бы отказ там, где никто ничего не опроверг.
      const opposed = decision.features.some((feature) => feature.weight < 0);
      if (features.length > 0 && (decision.status !== "rejected" || opposed)) {
        await this.store.recordMatch(subjectEntityId, entityId, decision);
      }
    }
    return entityId;
  }
}
