/**
 * Детектор эпизодов.
 *
 * Эпизод — законченный смысловой кусок разговора. Он существует, чтобы
 * Curator работал по осмысленной границе, а не по каждому сообщению:
 * «ага», «спасибо» и «до вечера» не стоят фонового хода модели, а
 * разговор о смене работы стоит.
 *
 * Детектор ДЕТЕРМИНИРОВАННЫЙ. Ни одна граница не определяется моделью:
 * иначе решение «пора ли думать» само стоило бы вызова модели, и
 * дешевизна фонового пути исчезла бы.
 *
 * Пять границ, названных требованием 1 шага:
 *
 *   topic_shift        — словарь разговора сменился;
 *   turn_completed     — ход завершён, и накоплено достаточно содержания;
 *   inactivity         — человек молчит дольше окна;
 *   explicit_important — он сам пометил сказанное важным;
 *   before_compaction  — контекст вот-вот сожмут, и материал исчезнет.
 *
 * Эпизод НЕ хранит переписку: только идентификаторы сообщений и
 * компактное содержание. Полное зеркало переписки запрещено.
 */

import type { Database } from "../db.js";

export type EpisodeBoundary =
  | "topic_shift"
  | "turn_completed"
  | "inactivity"
  | "explicit_important"
  | "before_compaction"
  | "manual";

export type EpisodePrivacy = "normal" | "sensitive" | "private";

export interface EpisodeSignal {
  kind: "message" | "turn_completed" | "inactivity" | "compaction" | "explicit";
  /** Текст сообщения нужен только для сравнения словарей и длины. */
  text?: string;
  messageId?: string | null;
  at: Date;
}

export interface EpisodeState {
  startedAt: Date;
  lastMessageAt: Date;
  messageIds: string[];
  /** Словарь текущего эпизода: значимые слова без служебных. */
  vocabulary: Set<string>;
  contentLength: number;
  privacy: EpisodePrivacy;
}

export interface BoundaryDecision {
  closed: boolean;
  reason: EpisodeBoundary | null;
  /** Стоит ли этот эпизод фонового хода Curator. */
  worthCurating: boolean;
}

/** Ниже этого объёма эпизод не окупает фоновый ход модели. */
export const MIN_CURATION_LENGTH = 120;
/** Меньше двух сообщений — это реплика, а не эпизод. */
export const MIN_CURATION_MESSAGES = 2;
/** Молчание, после которого эпизод считается законченным. */
export const INACTIVITY_MS = 20 * 60_000;
/** Доля общих слов, ниже которой тема считается сменившейся. */
export const TOPIC_OVERLAP_THRESHOLD = 0.12;

export function newEpisodeState(at: Date, privacy: EpisodePrivacy = "normal"): EpisodeState {
  return {
    startedAt: at,
    lastMessageAt: at,
    messageIds: [],
    vocabulary: new Set(),
    contentLength: 0,
    privacy,
  };
}

/**
 * Решить, закончился ли эпизод.
 *
 * Функция чистая: состояние передаётся и возвращается вызывающим. Это
 * позволяет проверить каждую границу тестом без базы и без разговора.
 */
export function detectBoundary(state: EpisodeState, signal: EpisodeSignal): BoundaryDecision {
  const worth = () =>
    state.contentLength >= MIN_CURATION_LENGTH
    && state.messageIds.length >= MIN_CURATION_MESSAGES;

  if (signal.kind === "explicit") {
    // Явно важное сообщение закрывает эпизод независимо от объёма:
    // человек сказал «запомни это», и ждать ещё двух реплик незачем.
    return { closed: true, reason: "explicit_important", worthCurating: true };
  }
  if (signal.kind === "compaction") {
    return { closed: true, reason: "before_compaction", worthCurating: worth() };
  }
  if (signal.kind === "inactivity"
    || signal.at.getTime() - state.lastMessageAt.getTime() >= INACTIVITY_MS) {
    return { closed: true, reason: "inactivity", worthCurating: worth() };
  }
  if (signal.kind === "message") {
    const words = significantWords(signal.text ?? "");
    if (state.vocabulary.size > 0 && words.length > 0) {
      const shared = words.filter((word) => state.vocabulary.has(word)).length;
      if (shared / words.length < TOPIC_OVERLAP_THRESHOLD) {
        return { closed: true, reason: "topic_shift", worthCurating: worth() };
      }
    }
    return { closed: false, reason: null, worthCurating: false };
  }
  // turn_completed: ход завершён. Эпизод закрывается, только если
  // накоплено достаточно — иначе короткий обмен репликами порождал бы
  // фоновый ход после каждого «ок».
  return worth()
    ? { closed: true, reason: "turn_completed", worthCurating: true }
    : { closed: false, reason: null, worthCurating: false };
}

export function absorb(state: EpisodeState, signal: EpisodeSignal): EpisodeState {
  const text = signal.text ?? "";
  for (const word of significantWords(text)) state.vocabulary.add(word);
  if (signal.messageId) state.messageIds.push(signal.messageId);
  state.contentLength += text.length;
  state.lastMessageAt = signal.at;
  return state;
}

/**
 * Значимые слова: длиннее трёх символов и не из служебного списка.
 * Список короткий намеренно — он служит сравнению словарей, а не
 * лингвистике, и разрастаясь начал бы прятать смену темы.
 */
const STOP_WORDS = new Set([
  "этот", "тот", "меня", "тебя", "себя", "если", "чтобы", "потому", "когда",
  "было", "будет", "быть", "есть", "как", "что", "the", "and", "for", "you",
]);

export function significantWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word))
    .slice(0, 200);
}

export interface EpisodeRow {
  id: number;
  conversationId: string;
  episodeKey: string;
  status: string;
  boundaryReason: EpisodeBoundary;
  privacyMode: EpisodePrivacy;
  messageIds: string[];
  summary: string | null;
  messageCount: number;
}

/**
 * Хранилище эпизодов.
 *
 * Все записи идут под областью владельца: эпизод — пользовательские
 * данные, и фоновый путь объявляет арендатора сам, потому что ход
 * человека к этому моменту уже закончился.
 */
export class EpisodeService {
  constructor(private readonly db: Database, private readonly enabled: boolean) {}

  get active(): boolean {
    return this.enabled;
  }

  /**
   * Закрыть эпизод.
   *
   * Идемпотентно по `episodeKey`: повторный сигнал той же границы не
   * создаёт второго эпизода и не переоткрывает закрытый.
   */
  async close(input: {
    userId: number;
    conversationId: string;
    episodeKey: string;
    boundaryReason: EpisodeBoundary;
    messageIds: readonly string[];
    summary?: string | null;
    privacyMode?: EpisodePrivacy;
    purpose?: string;
    startedAt?: Date;
    endedAt?: Date;
  }): Promise<EpisodeRow | null> {
    if (!this.enabled) return null;
    return await this.db.withUserScope(
      { userId: input.userId, label: "memory.episode.close", inherit: true },
      async () => {
        const { rows } = await this.db.query<EpisodeDbRow>(
          `INSERT INTO memory_episodes (
             user_id, conversation_id, episode_key, purpose, status,
             boundary_reason, summary, message_ids, privacy_mode,
             message_count, started_at, ended_at
           ) VALUES ($1, $2, $3, $4, 'closed', $5, $6, $7::text[], $8, $9, $10, $11)
           ON CONFLICT (user_id, episode_key) DO NOTHING
           RETURNING id, conversation_id, episode_key, status, boundary_reason,
                     privacy_mode, message_ids, summary, message_count`,
          [
            input.userId,
            input.conversationId,
            input.episodeKey,
            input.purpose ?? "chat",
            input.boundaryReason,
            input.summary ?? null,
            [...input.messageIds].slice(0, 200),
            input.privacyMode ?? "normal",
            input.messageIds.length,
            input.startedAt ?? new Date(),
            input.endedAt ?? new Date(),
          ],
        );
        return rows[0] ? toEpisode(rows[0]) : null;
      },
    );
  }

  /** Забрать закрытый эпизод под обработку. Повторный вызов вернёт null. */
  async claimForCuration(userId: number, episodeId: number): Promise<EpisodeRow | null> {
    return await this.db.withUserScope(
      { userId, label: "memory.episode.claim", inherit: true },
      async () => {
        const { rows } = await this.db.query<EpisodeDbRow>(
          `UPDATE memory_episodes
              SET status = 'curating'
            WHERE user_id = $1 AND id = $2 AND status = 'closed'
            RETURNING id, conversation_id, episode_key, status, boundary_reason,
                      privacy_mode, message_ids, summary, message_count`,
          [userId, episodeId],
        );
        return rows[0] ? toEpisode(rows[0]) : null;
      },
    );
  }

  async finish(
    userId: number,
    episodeId: number,
    status: "curated" | "skipped" | "failed",
  ): Promise<void> {
    await this.db.withUserScope(
      { userId, label: "memory.episode.finish", inherit: true },
      async () => {
        await this.db.query(
          `UPDATE memory_episodes
              SET status = $3,
                  curated_at = CASE WHEN $3 = 'curated' THEN now() ELSE curated_at END
            WHERE user_id = $1 AND id = $2`,
          [userId, episodeId, status],
        );
      },
    );
  }

  async byId(userId: number, episodeId: number): Promise<EpisodeRow | null> {
    return await this.db.withUserScope(
      { userId, label: "memory.episode.read", inherit: true },
      async () => {
        const { rows } = await this.db.query<EpisodeDbRow>(
          `SELECT id, conversation_id, episode_key, status, boundary_reason,
                  privacy_mode, message_ids, summary, message_count
             FROM memory_episodes
            WHERE user_id = $1 AND id = $2`,
          [userId, episodeId],
        );
        return rows[0] ? toEpisode(rows[0]) : null;
      },
    );
  }
}

/**
 * Отслеживание границ по ходу разговора.
 *
 * Состояние живёт в памяти процесса и намеренно: эпизод — это гипотеза
 * о том, где кончилась мысль, а не каноническое состояние. Перезапуск
 * сервиса теряет открытый эпизод, и это правильная цена: восстановленный
 * из PostgreSQL «недоговорённый» эпизод пришлось бы держать
 * согласованным между процессами ради данных, которые всё равно будут
 * пересобраны следующим разговором.
 *
 * Каноническое хранится только закрытым: `memory_episodes` получает
 * запись, когда граница уже определена.
 */
export class EpisodeTracker {
  private readonly open = new Map<string, EpisodeState>();

  constructor(
    private readonly episodes: EpisodeService,
    /** Что делать с закрытым эпизодом. Записью намерения занимается он. */
    private readonly onClosed: (episode: EpisodeRow, userId: number) => Promise<void>,
    private readonly logger?: { warn(message: string, fields?: Record<string, unknown>): void },
  ) {}

  /**
   * Принять сигнал.
   *
   * Не бросает и ничего не ждёт от вызывающего: детектор эпизодов не
   * имеет права уронить или задержать ответ человеку.
   */
  observe(input: {
    userId: number;
    conversationId: string;
    signal: EpisodeSignal;
    privacy?: EpisodePrivacy;
  }): void {
    if (!this.episodes.active) return;
    const key = `${input.userId}:${input.conversationId}`;
    const state = this.open.get(key) ?? newEpisodeState(input.signal.at, input.privacy ?? "normal");
    const decision = detectBoundary(state, input.signal);
    if (!decision.closed) {
      this.open.set(key, absorb(state, input.signal));
      return;
    }

    // Сообщение, СМЕНИВШЕЕ тему, принадлежит уже следующему эпизоду:
    // включив его в закрываемый, детектор отдал бы Curator кусок чужого
    // разговора.
    const closing = state;
    const next = newEpisodeState(input.signal.at, input.privacy ?? "normal");
    this.open.set(key, decision.reason === "topic_shift" ? absorb(next, input.signal) : next);

    if (!decision.worthCurating || closing.messageIds.length === 0) return;
    const episodeKey = [
      input.conversationId,
      closing.startedAt.toISOString(),
      closing.messageIds[closing.messageIds.length - 1] ?? "-",
    ].join(":").slice(0, 300);

    void this.episodes.close({
      userId: input.userId,
      conversationId: input.conversationId,
      episodeKey,
      boundaryReason: decision.reason ?? "manual",
      messageIds: closing.messageIds,
      privacyMode: closing.privacy,
      startedAt: closing.startedAt,
      endedAt: input.signal.at,
    }).then(async (episode) => {
      if (episode) await this.onClosed(episode, input.userId);
    }).catch((error: unknown) => {
      this.logger?.warn("Эпизод не закрыт", {
        userId: input.userId,
        code: error instanceof Error ? error.name : "unknown_error",
      });
    });
  }

  /** Сколько разговоров сейчас в открытом эпизоде. Для метрик и тестов. */
  get openCount(): number {
    return this.open.size;
  }
}

interface EpisodeDbRow {
  id: string;
  conversation_id: string;
  episode_key: string;
  status: string;
  boundary_reason: string;
  privacy_mode: string;
  message_ids: string[] | null;
  summary: string | null;
  message_count: number | string;
}

function toEpisode(row: EpisodeDbRow): EpisodeRow {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id,
    episodeKey: row.episode_key,
    status: row.status,
    boundaryReason: row.boundary_reason as EpisodeBoundary,
    privacyMode: row.privacy_mode as EpisodePrivacy,
    messageIds: row.message_ids ?? [],
    summary: row.summary,
    messageCount: Number(row.message_count),
  };
}
