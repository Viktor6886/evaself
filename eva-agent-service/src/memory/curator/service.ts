/**
 * Memory Curator.
 *
 * Что он такое: спецификация фонового хода агента из шага 8 плюс
 * серверный код, который превращает проверенный схемой результат в
 * версии памяти шага 15. Второго механизма извлечения здесь нет —
 * входом служит эпизод, собранный из уже существующего асинхронного
 * разбора разговора.
 *
 * Чего он не делает:
 *
 *   1. Не выполняется в пути ответа человеку. Единственная точка
 *      запуска — задание очереди; `enqueue()` только записывает
 *      намерение в `job_outbox` в чужой транзакции и возвращается.
 *   2. Не выполняет SQL и не пишет память (инвариант 18). Модель
 *      возвращает кандидатов, записывает их код в `applyCandidates()`.
 *   3. Не превращает чувствительный вывод в факт. Такой кандидат
 *      остаётся кандидатом до подтверждения человеком — требование 6.
 *   4. Не запускается параллельно сам с собой на одном пользователе:
 *      дедупликация `keep_last_if_active` из шага 8.
 */

import type { Database } from "../../db.js";
import type { Logger } from "../../logger.js";
import type { AgentJobRunner, AgentJobSpec } from "../../jobs/agent-job.js";
import type { JobEnvelopeInput } from "../../jobs/envelope.js";
import { dedupKey } from "../../jobs/policy.js";
import type { GraphNodeType } from "../graph-repository.js";
import type { EpisodeRow, EpisodeService } from "../episodes.js";
import { isInference, MemoryStatusError } from "../temporal/status.js";
import type { TemporalMemoryLayer } from "../temporal/index.js";
import { parseCuratorResult, type CuratorCandidate, type CuratorResult } from "./schema.js";

export interface CuratorRunInput {
  runId: string;
  userId: number;
  agentId: string;
  episodeId: number;
  parentConversationId: string;
  signal: AbortSignal;
  /** Предпросмотр: результат показывается, но ничего не пишется. */
  mode?: "apply" | "preview";
}

export interface CuratorOutcome {
  status: "succeeded" | "empty" | "invalid_result" | "failed" | "skipped";
  mode: "apply" | "preview";
  /** Что было бы записано (preview) или записано (apply). */
  candidates: CuratorCandidate[];
  applied: {
    created: number;
    versioned: number;
    deduplicated: number;
    pendingConfirmation: number;
    /** Кандидаты, которые записать нельзя: чужой тип или снятый факт. */
    skipped: number;
  };
  code?: string;
}

/** Типы узлов, которые Curator имеет право предлагать. */
const ALLOWED_NODE_TYPES: ReadonlySet<string> = new Set<GraphNodeType>([
  "profile_fact", "interest", "value", "person", "relationship",
  "event", "obstacle", "strategy", "decision",
]);

const EMPTY_APPLIED = {
  created: 0, versioned: 0, deduplicated: 0, pendingConfirmation: 0, skipped: 0,
};

export const CURATOR_JOB_TYPE = "memory_curator";

/**
 * Спецификация фонового хода.
 *
 * Инструкция написана в коде и не собирается из данных пользователя:
 * инструкция из данных — это внедрение промпта. В неё передаются только
 * идентификаторы эпизода и сообщений.
 */
export function curatorSpec(): AgentJobSpec {
  return {
    jobType: CURATOR_JOB_TYPE,
    // Назначение из существующего списка: `maintenance` — единственное,
    // из которого нельзя писать человеку и которому не разрешён ни один
    // инструмент. Curator и не должен ничего вызывать: он читает эпизод
    // и возвращает структуру.
    purpose: "maintenance",
    budget: { maxTokens: 6_000, maxDurationMs: 90_000, maxCostMicros: 40_000 },
    instruction: [
      "Ты извлекаешь долговременные факты из завершённого эпизода разговора.",
      "Бери только то, что человек сказал сам или что прямо следует из его слов.",
      "Догадку о состоянии, диагнозе или чувствах помечай needsConfirmation=true",
      "и privacyMode=sensitive. Диагнозов не ставь, лечения не назначай.",
      "Если ничего долговременного не прозвучало — верни пустой список.",
    ].join(" "),
    resultKinds: ["memory_candidates"],
    maxItems: 20,
    parseResult: (reply) => {
      const parsed = parseCuratorResult(reply);
      if (!parsed.ok) return { ok: false, code: parsed.code };
      return {
        ok: true,
        proposal: {
          kind: "memory_candidates",
          empty: parsed.result.empty,
          items: parsed.result.candidates.map((candidate) => ({
            kind: candidate.kind,
            ref: candidate.title,
            summary: candidate.value ?? candidate.title,
            confidence: candidate.confidence,
          })),
          confidence: parsed.result.candidates.length > 0
            ? Math.max(...parsed.result.candidates.map((item) => item.confidence))
            : 0,
          payload: parsed.result as unknown as Record<string, unknown>,
        },
      };
    },
    responseContract: [
      "Ответь ОДНИМ объектом JSON и ничем больше:",
      '{"candidates": [{"kind": "entity|fact|relation", "type": "<тип узла>",',
      '  "title": "<коротко>", "value": "<значение или null>",',
      '  "from": "<для связи>", "to": "<для связи>", "confidence": <0..1>,',
      '  "validFrom": "<ISO или null>", "validTo": "<ISO или null>",',
      '  "eventAt": "<ISO или null>", "messageIds": ["<id>"],',
      '  "privacyMode": "normal|sensitive|private", "needsConfirmation": <bool>}],',
      ' "uncertain": [{"note": "<что осталось неясным>", "confidence": <0..1>}]}',
      "messageIds обязателен: кандидат без ссылки на сообщение отбрасывается.",
      "Ничего не сохраняй и не отправляй — это предложение, а не действие.",
    ],
  };
}

export class MemoryCuratorService {
  constructor(
    private readonly db: Database,
    private readonly episodes: EpisodeService,
    private readonly memory: TemporalMemoryLayer,
    private readonly agentJobs: AgentJobRunner,
    private readonly logger: Logger,
    private readonly enabled: boolean,
  ) {}

  get active(): boolean {
    return this.enabled && this.memory.enabled;
  }

  /**
   * Намерение запустить Curator.
   *
   * Пишется в ту же транзакцию, что и закрытие эпизода, и ничего не
   * выполняет: путь ответа человеку не должен ждать ни модели, ни
   * брокера. Режим дедупликации — `keep_last_if_active`: пока задание
   * этого пользователя ещё живо, новое его заменяет, а не запускается
   * рядом.
   */
  intent(input: {
    userId: number;
    episodeId: number;
    conversationId: string;
    agentId?: string | null;
    traceId: string;
  }): JobEnvelopeInput {
    return {
      type: CURATOR_JOB_TYPE,
      queue: "memory",
      // Ключ идемпотентности по эпизоду: повторное закрытие того же
      // эпизода не ставит второго задания.
      idempotencyKey: `${CURATOR_JOB_TYPE}:${input.userId}:${input.episodeId}`,
      traceId: input.traceId,
      userId: input.userId,
      conversationId: input.conversationId,
      agentId: input.agentId ?? null,
      payload: { episode_id: input.episodeId },
      // Ключ дедупликации по ПОЛЬЗОВАТЕЛЮ, а не по эпизоду: параллельных
      // заданий не должно быть у человека, иначе два эпизода подряд
      // запустят два хода и оба начнут писать одну и ту же память.
      dedupKey: dedupKey({
        queue: "memory",
        type: CURATOR_JOB_TYPE,
        mode: "keep_last_if_active",
        userId: input.userId,
      }),
      dedupMode: "keep_last_if_active",
      deadlineMs: 10 * 60_000,
      source: "system",
      // Эпизод может содержать чувствительное: конверт объявляет это
      // сам, чтобы телеметрия знала об ограничении, а не догадывалась.
      privacy: "restricted",
    };
  }

  /**
   * Выполнить Curator по эпизоду.
   *
   * Предпросмотр отличается ровно одним: результат не применяется.
   * Ход модели, схема и журнал те же — иначе предпросмотр показывал бы
   * не то, что произойдёт.
   */
  async run(input: CuratorRunInput): Promise<CuratorOutcome> {
    const mode = input.mode ?? "apply";
    if (!this.active) {
      return { status: "failed", mode, candidates: [], applied: { ...EMPTY_APPLIED }, code: "memory_curator_disabled" };
    }

    const episode = mode === "apply"
      ? await this.episodes.claimForCuration(input.userId, input.episodeId)
      : await this.episodes.byId(input.userId, input.episodeId);
    if (!episode) {
      // Эпизод уже обработан другим заданием либо не существует.
      // Повторная обработка не создаёт дубликатов — она не начинается.
      return { status: "skipped", mode, candidates: [], applied: { ...EMPTY_APPLIED } };
    }

    const outcome = await this.agentJobs.run({
      runId: input.runId,
      userId: input.userId,
      agentId: input.agentId,
      parentConversationId: input.parentConversationId,
      signal: input.signal,
      spec: curatorSpec(),
      facts: {
        episode_id: episode.id,
        boundary: episode.boundaryReason,
        privacy_mode: episode.privacyMode,
        message_ids: episode.messageIds.slice(0, 40).join(","),
      },
    });

    if (outcome.status !== "succeeded" && outcome.status !== "empty") {
      await this.recordRun(input, mode, outcome.status === "invalid_result" ? "invalid_result" : "failed", null, EMPTY_APPLIED, "code" in outcome ? outcome.code : null);
      if (mode === "apply") await this.episodes.finish(input.userId, episode.id, "failed");
      return {
        status: outcome.status === "invalid_result" ? "invalid_result" : "failed",
        mode,
        candidates: [],
        applied: { ...EMPTY_APPLIED },
        code: "code" in outcome ? outcome.code : undefined,
      };
    }

    const result = outcome.status === "succeeded"
      ? outcome.proposal.payload as unknown as CuratorResult | undefined
      : undefined;
    const candidates = result?.candidates ?? [];
    if (candidates.length === 0) {
      await this.recordRun(input, mode, "empty", { candidates: [], uncertain: result?.uncertain ?? [], empty: true }, EMPTY_APPLIED, null);
      if (mode === "apply") await this.episodes.finish(input.userId, episode.id, "curated");
      return { status: "empty", mode, candidates: [], applied: { ...EMPTY_APPLIED } };
    }

    if (mode === "preview") {
      // Предпросмотр: ни одной записи в память. Журнал прогона при этом
      // ведётся — иначе «что бы записалось» нельзя ни показать, ни
      // разобрать по жалобе.
      await this.recordRun(input, mode, "succeeded", result ?? null, EMPTY_APPLIED, null);
      return { status: "succeeded", mode, candidates, applied: { ...EMPTY_APPLIED } };
    }

    const applied = await this.applyCandidates(input.userId, episode, candidates);
    await this.recordRun(input, mode, "succeeded", result ?? null, applied, null);
    await this.episodes.finish(input.userId, episode.id, "curated");
    return { status: "succeeded", mode, candidates, applied };
  }

  /**
   * Применить кандидатов.
   *
   * Здесь и только здесь принимаются решения, которые модели не
   * доверяются: статус кандидата, время действительности, дедупликация
   * и доказательства. Каждый кандидат проходит через temporal-запись
   * шага 15 — второго пути в память нет.
   */
  private async applyCandidates(
    userId: number,
    episode: EpisodeRow,
    candidates: readonly CuratorCandidate[],
  ): Promise<CuratorOutcome["applied"]> {
    const applied = { ...EMPTY_APPLIED };
    await this.db.withUserScope(
      { userId, label: "memory.curator.apply", inherit: true },
      async () => {
        await this.db.transaction(async (client) => {
          for (const candidate of candidates) {
            if (!ALLOWED_NODE_TYPES.has(candidate.type)) {
              applied.skipped += 1;
              continue;
            }
            const nodeType = candidate.type as GraphNodeType;
            const canonicalKey = `curator:${nodeType}:${canonical(candidate.title)}`;

            // Дедупликация до записи: совпавший узел получает
            // доказательство, а не близнеца.
            const duplicate = await this.memory.dedup.findNodeDuplicate(client, {
              userId, nodeType, canonicalKey, title: candidate.title,
            });

            const sensitive = candidate.privacyMode !== "normal"
              || candidate.needsConfirmation
              || isInference("curator");
            const evidence = candidate.messageIds.map((messageId) => ({
              sourceType: "curator",
              sourceId: `episode:${episode.id}`,
              messageId,
              episodeId: episode.id,
              sourceAt: new Date(),
              eventAt: candidate.eventAt ? new Date(candidate.eventAt) : null,
              excerpt: candidate.value ?? candidate.title,
              confidence: candidate.confidence,
            }));

            // Один негодный кандидат не отменяет остальных. Самый
            // важный случай — факт, который человек удалил: снимок
            // остался надгробием, переход из `deleted` запрещён, и
            // запись обязана быть пропущена, а не воскресить удалённое
            // и не уронить весь эпизод откатом транзакции.
            const outcome = await this.recordCandidate(client, {
              userId,
              nodeType,
              // Найденный дубликат пишется В СВОЙ ключ: иначе кандидат
              // получил бы собственный узел, и дедупликация нашла бы
              // дубль ровно затем, чтобы его создать.
              canonicalKey: duplicate?.canonicalKey ?? canonicalKey,
              title: candidate.title,
              textContent: candidate.value,
              contentJson: { episode_id: episode.id, curator: true, sensitive },
              // Вывод Curator — это вывод модели, а не слова человека.
              // Он приходит в память кандидатом всегда, независимо от
              // чувствительности: фактом его делает только человек в
              // Mini App (требования 6 и 9 шага).
              status: "candidate",
              sensitivity: candidate.privacyMode === "normal" ? "normal" : "sensitive",
              validFrom: candidate.validFrom ? new Date(candidate.validFrom) : undefined,
              validTo: candidate.validTo ? new Date(candidate.validTo) : null,
              eventAt: candidate.eventAt ? new Date(candidate.eventAt) : null,
              evidence,
              changeReason: `curator:${episode.boundaryReason}`,
              actorType: "curator",
            });

            if (!outcome) {
              applied.skipped += 1;
              continue;
            }
            if (outcome.outcome === "created") applied.created += 1;
            else if (outcome.outcome === "versioned") applied.versioned += 1;
            else applied.deduplicated += 1;
            applied.pendingConfirmation += 1;
          }
        });
      },
    );
    return applied;
  }

  /**
   * Записать одного кандидата.
   *
   * Запрещённый переход статуса — не поломка, а ответ: так система
   * говорит «этот факт закрыт». Возвращается `null`, и эпизод
   * доигрывается до конца.
   */
  private async recordCandidate(
    client: Parameters<TemporalMemoryLayer["versions"]["recordFact"]>[0],
    input: Parameters<TemporalMemoryLayer["versions"]["recordFact"]>[1],
  ): Promise<Awaited<ReturnType<TemporalMemoryLayer["versions"]["recordFact"]>> | null> {
    try {
      return await this.memory.versions.recordFact(client, input);
    } catch (error) {
      if (error instanceof MemoryStatusError) {
        this.logger.info("Кандидат Curator пропущен", { code: error.code });
        return null;
      }
      throw error;
    }
  }

  private async recordRun(
    input: CuratorRunInput,
    mode: "apply" | "preview",
    status: "succeeded" | "empty" | "invalid_result" | "failed",
    result: CuratorResult | null,
    applied: CuratorOutcome["applied"],
    errorCode: string | null,
  ): Promise<void> {
    try {
      await this.db.withUserScope(
        { userId: input.userId, label: "memory.curator.run", inherit: true },
        async () => {
          await this.db.query(
            `INSERT INTO memory_curator_runs (
               user_id, episode_id, run_id, mode, status, proposal, applied, error_code
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
             ON CONFLICT (user_id, run_id) DO NOTHING`,
            [
              input.userId,
              input.episodeId,
              input.runId,
              mode,
              status,
              JSON.stringify(result ?? {}),
              JSON.stringify(applied),
              errorCode,
            ],
          );
        },
      );
    } catch (error) {
      // Потеря журнала не отменяет уже применённый результат, но и
      // молчать о ней нельзя.
      this.logger.warn("Прогон Curator не записан", {
        code: error instanceof Error ? error.name : "unknown_error",
      });
    }
  }
}

function canonical(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200) || "unknown";
}
