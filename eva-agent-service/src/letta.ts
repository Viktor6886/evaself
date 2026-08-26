/**
 * The only place in Evaself that talks to Letta.
 *
 * Everything goes through the official `@letta-ai/letta-agent-sdk` against a
 * self-hosted Letta App Server (`letta server --listen ws://…`). There is no
 * hand-written REST client any more, and nothing else in the stack is
 * allowed to reach the App Server directly.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import type {
  AnyAgentTool,
  CanUseToolCallback,
  CreateAgentOptions,
  DreamingOptions,
  LettaCodeSession,
  LettaCodeClientSessionOptions,
  ListMessagesResult,
  PermissionMode,
  ReasoningEffort,
  SDKMessage,
  SendMessage,
} from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import {
  appServerUnavailable,
  EvaError,
  notFound,
  toEvaError,
  turnCancelled,
  turnTimeout,
} from "./errors.js";
import { missingCapabilities } from "./letta/capabilities.js";
import { type AgentToolCall, collectToolCalls } from "./letta/tool-calls.js";
import {
  evaluateReadiness,
  type ObservedRuntime,
  type ReadinessReport,
} from "./letta/readiness.js";
import {
  catalogSupportsEffort,
  isReasoningTierError,
  type ModelCatalogEntry,
} from "./letta/reasoning-tier.js";
import {
  type EvaMemoryBlock,
  ensureCoreMemoryBlocks,
  evaMemoryBlocks,
} from "./letta/memory-blocks.js";
import type { Logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Идентификатор shard этого процесса. Шардирования шаг не вводит, но
 * сессия обязана знать, чья она: без этого поля будущее шардирование
 * пришлось бы вводить переписыванием структуры сессии.
 */
const SHARD_ID = `shard-0:${process.pid}`;

/**
 * Как часто спрашивать барьер отмены во время потока. Компромисс между
 * задержкой обнаружения и нагрузкой на базу: событий в ходе сотни.
 */
const CANCEL_POLL_MS = 400;

/**
 * Состав memory blocks живёт в `./letta/memory-blocks.js`: у него появился
 * второй потребитель — синхронизация блоков через control plane. Реэкспорт
 * сохранён, чтобы шаг не переписывал импорты потребителей заодно с делом.
 */
export { evaMemoryBlocks };
export type { EvaMemoryBlock };

/**
 * Распознавание отказа каталога в уровне reasoning живёт в
 * `./letta/reasoning-tier.js`. Реэкспорт оставлен для тестов и потребителей:
 * снаружи это одно свойство поведения Letta, а не два модуля.
 */
export { isReasoningTierError };

/** Every agent Evaself creates carries these, so they are findable from Letta alone. */
export const EVASELF_TAG = "evaself";
export const EVA_AGENT_TAG = "eva-companion";
export const telegramTag = (telegramId: number | string) => `tg:${telegramId}`;

export interface TurnResult {
  reply: string;
  /**
   * Сколько событий reasoning пришло за ход. Только число: сырые
   * рассуждения не сохраняются, не трассируются и не показываются
   * (инвариант 19).
   */
  reasoningEvents: number;
  /**
   * Сколько отдельных сообщений ассистента пришло за ход и были ли у них
   * идентификаторы срезов. Только счётчики, без текста: содержимое
   * разговора в логи не попадает.
   */
  assistantGroups: number;
  assistantHadIds: boolean;
  toolCalls: string[];
  /**
   * Метаданные фактических вызовов инструментов: имя, идентификатор
   * вызова, run и исход. По ним видно, открывала ли Ева навык на самом
   * деле, — в отличие от её собственных слов об этом.
   */
  toolCallRecords: AgentToolCall[];
  /** Sanitized SDK events for the protected administrative trace viewer. */
  trace: Array<Record<string, unknown>>;
  stopReason: string | null;
  usage: Record<string, unknown> | null;
  messageCount: number;
  agentId: string;
  conversationId: string | null;
  /**
   * Идентификаторы run из потока SDK. Нужны восстановлению: по ним
   * ход опознаётся на стороне Letta. Сверку по ним Agent SDK не
   * поддерживает — у него нет read-API по идентификатору, — но сам
   * идентификатор он отдаёт, и терять его нельзя.
   */
  runIds: string[];
  durationMs: number;
  /**
   * Сколько ход ждал свободную сессию из пула. Отдельно от генерации:
   * ожидание сессии и работа модели лечатся разным, и общая длительность
   * их не различает.
   */
  sessionAcquireMs: number;
  /**
   * Через сколько после отправки сообщения пришёл первый срез текста.
   * `null` — текста в ходе не было вовсе (только инструменты). Это и есть
   * задержка, которую человек ощущает как «Ева думает».
   */
  firstDeltaMs: number | null;
}

/**
 * Срез ответа модели.
 *
 * Поток отдаёт ответ кусками, и куски принадлежат разным сообщениям: в
 * агентном ходе модель сперва проговаривает, что собирается сделать
 * («сейчас посмотрю»), вызывает инструмент и только потом отвечает
 * человеку. Ответ — последнее сообщение, всё до него показывать нельзя.
 *
 * Поэтому срез несёт не только текст: `startsGroup` означает, что
 * началось новое сообщение и показанное до сих пор нужно убрать, а не
 * дописать.
 */
export interface AssistantDelta {
  /** Текст среза как пришёл, без обрезки: провайдер рвёт слова между событиями. */
  text: string;
  /** Номер логического сообщения в ходе, с нуля. */
  group: number;
  /** Срез открывает новое сообщение: показанное раньше к ответу не относится. */
  startsGroup: boolean;
}

interface PooledSession {
  session: LettaCodeSession;
  conversationId: string;
  lastUsedAt: number;
  /** Set once bootstrapState() has reconciled a session resumed after a restart. */
  recovered: boolean;
  /**
   * Сколько ходов выполняется в этой сессии прямо сейчас. Пока счётчик
   * не ноль, сессию нельзя ни вытеснить, ни закрыть: закрытие посреди
   * хода означает оборванную генерацию и потерянный ответ.
   */
  activeTurns: number;
  /**
   * Сессию попросили закрыть, но ход ещё идёт. Она закроется сама, как
   * только счётчик дойдёт до нуля, и новых ходов больше не примет.
   */
  closing: boolean;
  /**
   * Идентификатор shard. Шардирования этот шаг не вводит намеренно —
   * поле заведено, чтобы шаг, который его введёт, не переписывал
   * структуру сессии.
   */
  shardId: string;
}

export type EvaSystemPromptPreset =
  | "default"
  | "letta-claude"
  | "letta-codex"
  | "letta-gemini"
  | "claude"
  | "codex"
  | "gemini";

/**
 * Возможности, которые runtime подтвердил сам, а не мы предположили.
 * Приходят в init-сообщении сессии Agent SDK.
 */
export interface LettaRuntimeFacts {
  model: string;
  memfsEnabled: boolean | null;
  skillSources: string[] | null;
  tools: string[] | null;
  dreaming: { trigger: string; behavior: string; stepCount: number } | null;
  observedAt: string;
}

/**
 * Что сессия сообщила о себе при открытии.
 *
 * `bootstrapState()` называет состав инструментов, `getDeviceStatus()` —
 * рабочий каталог памяти агента, режим разрешений и связь с устройством.
 * Оба вызова публичные и не требуют хода модели, поэтому готовность
 * считается по ним, а не по догадкам о конфигурации.
 */
export interface LettaSessionFacts {
  tools: string[] | null;
  /** Клиентские инструменты, переданные этой сессии. */
  clientTools: string[];
  model: string | null;
  memoryDirectory: string | null;
  workingDirectory: string | null;
  permissionMode: string | null;
  isOnline: boolean | null;
  observedAt: string;
}

export interface RuntimeSdkSettings {
  agent_name_prefix: string;
  default_description: string;
  default_persona: string;
  default_human_template: string;
  default_tags: string[];
  permissionMode: PermissionMode;
  reasoning_effort: ReasoningEffort;
  memfs_enabled: boolean;
  base_tools: string[] | null;
  dreaming: Record<string, unknown>;
  model_settings: Record<string, unknown>;
  default_context_window: number | null;
  conversation_summary: string;
  conversation_description: string;
  conversation_hidden: boolean;
  create_conversation: boolean;
  session_pool_size: number;
  session_idle_ms: number;
  turn_timeout_ms: number;
  app_server_request_timeout_ms: number;
}

export interface ManagedAgentInput {
  name: string;
  description?: string;
  hidden?: boolean;
  personality?: string;
  embedding?: string;
  persona?: string;
  human?: string;
  memory?: EvaMemoryBlock[];
  tags?: string[];
  model?: string;
  model_settings?: Record<string, unknown>;
  context_window?: number | null;
  permission_mode?: PermissionMode;
  memfs_enabled?: boolean;
  system_prompt_preset?: EvaSystemPromptPreset;
  system_prompt_append?: string;
  base_tools?: string[] | null;
  dreaming?: Record<string, unknown>;
  create_conversation?: boolean;
}

/**
 * Collapses the SDK's message stream into the fields the runtime and WebUI need.
 * The stream carries assistant text, reasoning, tool calls and a final
 * `result`; a Telegram reply only wants the text, but the rest is worth
 * returning for logging and debugging.
 */
export function summarizeStream(
  messages: SDKMessage[],
): Omit<TurnResult, "agentId" | "conversationId" | "durationMs" | "sessionAcquireMs" | "firstDeltaMs"> {
  let reasoningEvents = 0;
  const toolCalls: string[] = [];
  const trace: Array<Record<string, unknown>> = [];
  const runIds = new Set<string>();
  let stopReason: string | null = null;
  let usage: Record<string, unknown> | null = null;

  // Сообщения ассистента приходят срезами: несколько событий с общим
  // uuid — это один логический ответ, разрезанный потоком. Разные uuid —
  // разные сообщения.
  //
  // В агентном ходе их несколько: перед каждым вызовом инструмента
  // модель проговаривает, что собирается делать («Let me search for
  // both.»), и только последнее сообщение — ответ пользователю. Раньше
  // склеивались все подряд, и в Telegram уходил ход мыслей вместе с
  // ответом и без разделителей.
  const groups: Array<{ key: string; parts: string[] }> = [];
  // Если SDK не присылает ни uuid, ни otid, разделить сообщения нечем —
  // это важно знать при разборе жалоб на утёкшие рассуждения.
  let sawSliceIds = false;

  for (const message of messages) {
    trace.push(sanitizeTraceMessage(message));
    // `runId` приходит на сообщениях ассистента, вызовах инструментов и
    // reasoning, `runIds` — на итоговом сообщении. Собираем отовсюду:
    // ход может состоять из нескольких run.
    const withRun = message as { runId?: string; runIds?: string[] };
    if (withRun.runId) runIds.add(withRun.runId);
    for (const id of withRun.runIds ?? []) runIds.add(id);
    switch (message.type) {
      case "assistant": {
        const raw = message as { content?: unknown; uuid?: string; otid?: string | null };
        const text = extractText(raw.content);
        if (!text) break;
        // otid — стабильный ключ среза, uuid — идентификатор сообщения.
        // Если не пришло ни того, ни другого, считаем срез продолжением
        // предыдущего: это прежнее поведение и для одиночного ответа оно
        // верное.
        if (raw.otid || raw.uuid) sawSliceIds = true;
        const key = raw.otid ?? raw.uuid ?? groups.at(-1)?.key ?? "single";
        const last = groups.at(-1);
        if (last && last.key === key) last.parts.push(text);
        else groups.push({ key, parts: [text] });
        break;
      }
      case "reasoning": {
        // Событие считается, содержимое не читается: сырое рассуждение
        // не должно существовать нигде за пределами runtime Letta.
        reasoningEvents += 1;
        break;
      }
      case "tool_call": {
        const name = (message as { name?: string; toolName?: string }).name
          ?? (message as { toolName?: string }).toolName;
        if (name) toolCalls.push(name);
        break;
      }
      case "result": {
        const result = message as { stopReason?: string; stop_reason?: string; usage?: Record<string, unknown>; result?: unknown };
        stopReason = result.stopReason ?? result.stop_reason ?? null;
        usage = result.usage ?? null;
        // Some harness versions put the final text only on the result.
        if (groups.length === 0) {
          const text = extractText(result.result);
          if (text) groups.push({ key: "result", parts: [text] });
        }
        break;
      }
      default:
        break;
    }
  }

  // Внутри группы срезы склеиваются как есть: провайдер рвёт слова между
  // событиями, и любой разделитель здесь разорвал бы слово.
  const rendered = groups.map((group) => group.parts.join("").trim()).filter(Boolean);
  // Ответ — последнее сообщение. Всё, что модель сказала до него, это
  // рассуждение вслух: оно не уходит ни пользователю, ни в трассу —
  // от него остаётся только счётчик сообщений.
  const reply = rendered.at(-1) ?? "";

  return {
    reply: reply.trim(),
    reasoningEvents,
    assistantGroups: rendered.length,
    assistantHadIds: sawSliceIds,
    toolCalls,
    toolCallRecords: collectToolCalls(messages),
    trace,
    stopReason,
    usage,
    messageCount: messages.length,
    runIds: [...runIds],
  };
}

/** SDK content is a string, or a list of content parts. */
export function extractText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        parts.push(item);
      } else if (item && typeof item === "object") {
        const part = item as { type?: string; text?: string };
        if ((part.type === undefined || part.type === "text") && part.text) parts.push(part.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof content === "object") {
    const part = content as { text?: string };
    if (typeof part.text === "string") return part.text;
  }
  return String(content);
}

function requiredFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n[\s\S]*?\n---\n/);
  if (!match) throw new Error("persona projection has no YAML frontmatter");
  return match[0];
}

export class LettaService {
  private client: LettaAgentClient;
  private readonly sessions = new Map<string, PooledSession>();
  /**
   * Безопасный менеджер сессий: активная сессия не вытесняется и не
   * закрывается. Выключенный флаг возвращает прежнее поведение —
   * закрытие в любой момент.
   */
  private readonly safeSessions: boolean;
  /** Сколько ждать освобождения сессий при смене настроек и остановке. */
  private readonly drainTimeoutMs: number;
  /** Conversation, по которым ход выполняется прямо сейчас. */
  private readonly runningTurns = new Set<string>();

  /** Последний снимок фактических возможностей сессии (init-сообщение SDK). */
  private lastRuntimeFacts: LettaRuntimeFacts | null = null;
  private lastSessionFacts: LettaSessionFacts | null = null;
  private lastClientTools: string[] = [];

  private readonly config: Config;
  private readonly logger: Logger;
  /**
   * Канонические тексты личности.
   *
   * Не `readonly`: администратор правит персону и системный промпт из
   * панели, и применение правки не должно требовать перезапуска стека.
   * Меняются они ровно одним способом — `setCanonicalContext()`, который
   * вызывает владелец канонических текстов; никакой другой код их не
   * трогает.
   */
  private persona: string;
  private systemPrompt: string;
  private defaultModel: string;
  private runtime: RuntimeSdkSettings;
  private toolFactory: ((conversationId: string) => AnyAgentTool[]) | null = null;
  private sessionApprovalResolver: ((conversationId: string) => Promise<CanUseToolCallback>) | null = null;
  /**
   * Уровень reasoning, который текущая модель заведомо не предлагает.
   *
   * Запомненный вывод избавляет каждую следующую сессию от заведомо
   * провального round trip. Сбрасывается при смене модели и при смене
   * настроек: и то, и другое делает прежний вывод неотносящимся к делу.
   */
  private unsupportedReasoningEffort: ReasoningEffort | null = null;

  constructor(config: Config, logger: Logger, persona: string, systemPrompt: string) {
    this.config = config;
    this.logger = logger;
    this.persona = persona;
    this.systemPrompt = systemPrompt;
    this.defaultModel = config.model;
    this.safeSessions = config.safeSessionManager;
    this.drainTimeoutMs = config.sessionDrainMs;
    this.runtime = {
      agent_name_prefix: "eva",
      default_description: "Агент Evaself",
      default_persona: persona,
      default_human_template: "Имя: {{display_name}}\nTelegram ID: {{telegram_id}}",
      default_tags: [EVASELF_TAG],
      permissionMode: "standard",
      reasoning_effort: "none",
      memfs_enabled: true,
      base_tools: null,
      // Рефлексия Letta включается на событии сжатия контекста: именно
      // там у неё есть что осмыслить, и именно там она не стоит лишнего
      // хода в живом разговоре.
      dreaming: { trigger: "compaction-event" },
      model_settings: {},
      default_context_window: null,
      conversation_summary: "Новый диалог",
      conversation_description: "",
      conversation_hidden: false,
      create_conversation: true,
      session_pool_size: config.sessionPoolSize,
      session_idle_ms: config.sessionIdleMs,
      turn_timeout_ms: config.turnTimeoutMs,
      app_server_request_timeout_ms: config.appServerRequestTimeoutMs,
    };
    this.client = this.createClient();
  }

  /**
   * Сверить установленный пакет с проверенной матрицей возможностей.
   *
   * Та же проверка, что делает contract-тест, но на живом развёртывании:
   * тест доказывает контракт на сборке, а здесь canary убеждается, что
   * рядом с ним лежит именно проверенный пакет. Различие важно — версия
   * SDK один раз уже уехала групповым обновлением зависимостей, и на
   * сборке это никого не разбудило.
   *
   * Сессия для проверки открывается на несуществующем conversation:
   * конструктор соединения не устанавливает, а нужны только имена
   * методов. Обращения к App Server здесь нет.
   */
  verifyContract(): { ok: boolean; missing: string[] } {
    const resolve = (root: unknown) => (path: string): unknown => {
      let current: unknown = root;
      for (const part of path.split(".")) {
        if (current === null || current === undefined) return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    };
    const probeSession = this.client.resumeSession("contract-probe", {
      cwd: "/data/letta",
    });
    const missing = [
      ...missingCapabilities("agent-sdk", resolve(this.client)),
      ...missingCapabilities("session", resolve(probeSession)),
    ];
    try {
      probeSession.close();
    } catch {
      // Пробная сессия ничего не открывала: закрытие — гигиена, а не
      // обязательство, и его отказ не должен ломать проверку.
    }
    return { ok: missing.length === 0, missing: missing.map((entry) => entry.id) };
  }

  private createClient(): LettaAgentClient {
    return new LettaAgentClient({
      backend: "remote",
      url: this.config.appServerUrl,
      ...(this.config.appServerToken ? { authToken: this.config.appServerToken } : {}),
      requestTimeoutMs: this.runtime.app_server_request_timeout_ms,
    });
  }

  resetClient(): void {
    this.closeAllSessions();
    this.client = this.createClient();
  }

  setDefaultModel(model: string): void {
    // Вывод о поддержке уровня относится к конкретной модели, а не к
    // сервису: у новой модели каталог может знать этот уровень.
    if (model !== this.defaultModel) this.unsupportedReasoningEffort = null;
    this.defaultModel = model;
  }

  /**
   * Заменить канонические тексты личности без перезапуска процесса.
   *
   * Нужно ровно одному сценарию: администратор сохранил персону или
   * системный промпт в панели, и следующий созданный агент обязан
   * получить новый текст, а не тот, что процесс прочитал при старте.
   * Существующих агентов приводит к новой версии `PersonaSync` — здесь
   * меняется только то, из чего собирается **новый** агент и новая
   * сессия.
   *
   * Открытые сессии выводятся из обращения: `sessionOptions()` уже отдала
   * им прежнюю персону, и оставить их значило бы получить два разных
   * канонических текста в одном процессе.
   *
   * Именно выводятся, а не закрываются. `closeAllSessions()` при
   * выключенном `EVA_SAFE_SESSION_MANAGER` — а он выключен по умолчанию —
   * закрывает и ту сессию, в которой прямо сейчас идёт ход. Человек в
   * этот момент ждёт ответа, и администратор, сохранивший персону,
   * обрывал бы чужой разговор на середине. Сохранение персоны — как раз
   * тот момент, когда кто-то с Евой разговаривает.
   *
   * Поэтому здесь та же механика, что и у `invalidateAgentSessions`:
   * занятая сессия помечается `closing` и закрывается сама, когда ход
   * закончится, свободная — сразу. Идущий ход при этом доработает на
   * прежнем тексте: это честнее, чем оборвать его ради новой персоны,
   * которую всё равно применит `PersonaSync`.
   */
  setCanonicalContext(input: { persona?: string; systemPrompt?: string }): boolean {
    const persona = input.persona ?? this.persona;
    const systemPrompt = input.systemPrompt ?? this.systemPrompt;
    if (persona === this.persona && systemPrompt === this.systemPrompt) return false;
    this.persona = persona;
    this.systemPrompt = systemPrompt;
    this.runtime = { ...this.runtime, default_persona: persona };
    this.retireAllSessions();
    return true;
  }

  /**
   * Вывести из обращения все открытые сессии, не обрывая идущих ходов.
   *
   * Свободная сессия закрывается сразу, занятая помечается и закрывается
   * по окончании хода (`closeIfDrained`). Ни одна из них не будет выдана
   * следующему ходу: он откроет новую — уже с текущим каноническим
   * текстом.
   */
  private retireAllSessions(): void {
    for (const [conversationId, pooled] of [...this.sessions]) {
      if (pooled.activeTurns > 0) pooled.closing = true;
      else this.closeSession(conversationId);
    }
  }

  /** Что процесс считает каноническим прямо сейчас. Только для диагностики. */
  canonicalContext(): { persona: string; systemPrompt: string } {
    return { persona: this.persona, systemPrompt: this.systemPrompt };
  }

  setToolFactory(factory: (conversationId: string) => AnyAgentTool[]): void {
    this.toolFactory = factory;
    this.closeAllSessions();
  }

  /**
   * Подтверждение действия человеком для живой сессии.
   *
   * Набор инструментов сессии сюда не приходит: его определяет Letta.
   * Здесь остаётся только вопрос «спросить ли владельца перед вызовом».
   */
  setSessionApprovalResolver(resolver: (conversationId: string) => Promise<CanUseToolCallback>): void {
    this.sessionApprovalResolver = resolver;
    this.closeAllSessions();
  }

  get currentPersona(): string {
    return this.persona;
  }

  /**
   * Новые настройки применяются к следующему ходу, а текущие имеют право
   * договорить: сессии уходят через graceful drain, а не закрываются
   * посреди генерации. При выключенном безопасном менеджере поведение
   * прежнее — немедленное закрытие.
   */
  async applySdkSettings(settings: RuntimeSdkSettings): Promise<void> {
    const reconnect =
      settings.app_server_request_timeout_ms !== this.runtime.app_server_request_timeout_ms;
    this.runtime = settings;
    // Администратор мог выбрать другой уровень reasoning; прежний вывод о
    // его поддержке к новому значению не относится.
    this.unsupportedReasoningEffort = null;
    if (this.safeSessions) await this.drainSessions(this.drainTimeoutMs);
    else this.closeAllSessions();
    if (reconnect) this.client = this.createClient();
  }

  /**
   * Есть ли у активной модели запрошенный уровень reasoning.
   *
   * `checked: false` означает, что каталог недоступен и вывода нет — это не
   * «не поддерживается». Настройку в таком случае блокировать нельзя:
   * администратор не должен зависеть от того, поднят ли App Server.
   */
  async reasoningEffortSupport(effort: ReasoningEffort): Promise<{
    checked: boolean;
    supported: boolean;
    model: string;
  }> {
    const model = this.defaultModel;
    if (effort === "none") return { checked: true, supported: true, model };
    if (!model) return { checked: false, supported: false, model };
    let entries: ModelCatalogEntry[];
    try {
      entries = ((await this.client.models.list()).entries ?? []) as ModelCatalogEntry[];
    } catch {
      return { checked: false, supported: false, model };
    }
    return { checked: true, supported: catalogSupportsEffort(entries, model, effort), model };
  }

  // -----------------------------------------------------------------
  // health
  // -----------------------------------------------------------------

  /** Cheap round trip that proves the WebSocket and the protocol both work. */
  async ping(): Promise<{ ok: true; models: number } | { ok: false; error: string }> {
    try {
      // agents.list proves WebSocket + protocol even when a provider does not
      // implement /models and its model name was entered manually.
      await this.client.agents.list({ limit: 1 });
      try {
        const models = await this.client.models.list();
        return { ok: true, models: models.entries?.length ?? 0 };
      } catch {
        return { ok: true, models: -1 };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // -----------------------------------------------------------------
  // agents
  // -----------------------------------------------------------------

  async listAgents(): Promise<unknown[]> {
    try {
      return (await this.client.agents.list({})) as unknown[];
    } catch (error) {
      throw toEvaError(error, "listing agents");
    }
  }

  /**
   * Look an agent up by its Telegram tag. Used when the database was
   * restored without the App Server state, or the other way round.
   */
  async findAgentByTelegramId(telegramId: number): Promise<string | null> {
    try {
      const agents = await this.client.agents.list({
        tags: [EVASELF_TAG, telegramTag(telegramId)],
        matchAllTags: true,
        limit: 1,
      });
      return agents?.[0]?.id ?? null;
    } catch (error) {
      throw toEvaError(error, "finding an agent by telegram id");
    }
  }

  /** Create the personal Eva agent for one Telegram user. */
  async createAgent(input: {
    telegramId: number;
    displayName: string;
    human?: string;
  }): Promise<string> {
    const persona = this.persona;
    const human =
      input.human ??
      this.runtime.default_human_template
        .replaceAll("{{display_name}}", input.displayName)
        .replaceAll("{{telegram_id}}", String(input.telegramId));
    const options: CreateAgentOptions = {
      name: `${this.runtime.agent_name_prefix}-${input.telegramId}`,
      description:
        this.runtime.default_description ||
        `Агент Evaself для пользователя Telegram ${input.telegramId}`,
      persona,
      human,
      tags: [...new Set([
        ...this.runtime.default_tags,
        EVASELF_TAG,
        EVA_AGENT_TAG,
        "psychology",
        "self-knowledge",
        telegramTag(input.telegramId),
      ])],
      permissionMode: this.runtime.permissionMode,
      // MemFS — часть агента, а не сессии: без него у Letta нет ни
      // файловой памяти, ни agent-skills, ни рефлексии над ними.
      memfs: this.runtime.memfs_enabled,
      dreaming: this.runtime.dreaming as DreamingOptions,
      memory: evaMemoryBlocks(persona, human),
      // Официальный raw override Agent SDK. Текст читается из tracked-файла,
      // а не дублируется в TypeScript и не зависит от внутреннего bundle Letta.
      systemPrompt: this.systemPrompt,
      // `skillSources` тоже не передаётся: умолчание CLI — все источники
      // (bundled, global, agent, project), и сузить их значит выключить
      // часть механизма навыков.
      ...(this.runtime.base_tools !== null ? { baseTools: this.runtime.base_tools } : {}),
      ...(this.defaultModel ? { model: this.defaultModel } : {}),
    };

    try {
      const agentId = await this.client.createAgent(options);
      if (
        Object.keys(this.runtime.model_settings).length > 0 ||
        this.runtime.default_context_window !== null
      ) {
        await this.client.agents.update(agentId, {
          ...(Object.keys(this.runtime.model_settings).length > 0
            ? { modelSettings: this.runtime.model_settings }
            : {}),
          ...(this.runtime.default_context_window !== null
            ? { contextWindowLimit: this.runtime.default_context_window }
            : {}),
        } as never);
      }
      this.logger.info("created agent", { telegramId: input.telegramId, agentId });
      return agentId;
    } catch (error) {
      throw toEvaError(error, "creating an agent");
    }
  }

  /** Обновить prompt существующего агента без пересоздания и смены agent_id. */
  async updateAgentSystemPrompt(agentId: string, systemPrompt: string): Promise<boolean> {
    try {
      const agent = await this.client.agents.retrieve(agentId) as { system?: unknown };
      if (agent.system === systemPrompt) return false;
      await this.client.agents.update(agentId, { system: systemPrompt });
      return true;
    } catch (error) {
      throw toEvaError(error, `updating the system prompt of ${agentId}`);
    }
  }

  /**
   * Replace only the managed persona projection in the agent's MemFS.
   *
   * SDK 0.7.1 deliberately exposes the active checkout through
   * getDeviceStatus(), but has no public self-hosted file mutation API. The
   * App Server and this service therefore share the same persistent volume;
   * the write follows Letta Code's own supported local MemFS convention:
   * preserve frontmatter, update system/persona.md, and commit that path.
   */
  async updateAgentPersona(
    agentId: string,
    conversationId: string,
    persona: string,
  ): Promise<boolean> {
    this.closeSession(conversationId);
    const session = this.client.resumeSession(conversationId, await this.sessionOptions(conversationId));
    let memoryRoot: string | null = null;
    let current: string | null = null;
    let frameworkCurrent: string | null = null;
    let changedPaths: string[] = [];
    try {
      await session.bootstrapState();
      const status = await session.getDeviceStatus({
        timeoutMs: Math.min(this.runtime.app_server_request_timeout_ms, 15_000),
      });
      if (session.agentId && session.agentId !== agentId) {
        throw new Error("conversation belongs to a different agent");
      }
      if (!status.memoryDirectory) throw new Error("MemFS memory directory is unavailable");
      memoryRoot = resolve(status.memoryDirectory);
      const personaPath = join(memoryRoot, "system", "persona.md");
      if (relative(memoryRoot, personaPath).startsWith("..")) {
        throw new Error("persona projection is outside the MemFS checkout");
      }
      current = await readFile(personaPath, "utf8");
      const frontmatter = requiredFrontmatter(current);
      const next = `${frontmatter}${persona.trim()}\n`;
      const framework = evaMemoryBlocks(persona).find(
        (block) => block.label === "therapeutic_framework",
      )!;
      const frameworkPath = join(memoryRoot, "system", "therapeutic_framework.md");
      frameworkCurrent = await readFile(frameworkPath, "utf8").catch(() => "");
      const frameworkFrontmatter = frameworkCurrent
        ? requiredFrontmatter(frameworkCurrent)
        : `---\ndescription: ${framework.description}\n---\n`;
      const frameworkNext = `${frameworkFrontmatter}${framework.value.trim()}\n`;
      const personaChanged = current.replace(/\r\n/g, "\n") !== next;
      const frameworkChanged = frameworkCurrent.replace(/\r\n/g, "\n") !== frameworkNext;
      if (!personaChanged && !frameworkChanged) return false;

      changedPaths = [
        ...(personaChanged ? ["system/persona.md"] : []),
        ...(frameworkChanged ? ["system/therapeutic_framework.md"] : []),
      ];
      if (personaChanged) await writeFile(personaPath, next, "utf8");
      if (frameworkChanged) await writeFile(frameworkPath, frameworkNext, "utf8");
      await execFileAsync("git", [
        "-c", "user.name=Evaself",
        "-c", `user.email=${agentId}@letta.com`,
        "add", "--", ...changedPaths,
      ], { cwd: memoryRoot, timeout: 10_000 });
      await execFileAsync("git", [
        "-c", "user.name=Evaself",
        "-c", `user.email=${agentId}@letta.com`,
        "commit", "-m", "chore: sync canonical Eva context", "--", ...changedPaths,
      ], { cwd: memoryRoot, timeout: 15_000 });
      return true;
    } catch (error) {
      if (memoryRoot && changedPaths.length > 0 && current !== null && frameworkCurrent !== null) {
        const personaPath = join(memoryRoot, "system", "persona.md");
        const frameworkPath = join(memoryRoot, "system", "therapeutic_framework.md");
        await Promise.all([
          changedPaths.includes("system/persona.md")
            ? writeFile(personaPath, current, "utf8")
            : Promise.resolve(),
          changedPaths.includes("system/therapeutic_framework.md")
            ? writeFile(frameworkPath, frameworkCurrent, "utf8")
            : Promise.resolve(),
        ]).then(async () => {
          await execFileAsync("git", ["add", "--", ...changedPaths], {
            cwd: memoryRoot!, timeout: 10_000,
          });
        }).catch(() => undefined);
      }
      throw toEvaError(error, `updating the persona projection of ${agentId}`);
    } finally {
      session.close();
    }
  }

  // -----------------------------------------------------------------
  // conversations
  // -----------------------------------------------------------------

  async listConversations(agentId: string): Promise<unknown[]> {
    try {
      return (await this.client.conversations.list({ agentId } as never)) as unknown[];
    } catch (error) {
      throw toEvaError(error, "listing conversations");
    }
  }

  async getConversation(conversationId: string): Promise<unknown> {
    try {
      return await this.client.conversations.retrieve(conversationId);
    } catch (error) {
      throw toEvaError(error, `retrieving conversation ${conversationId}`);
    }
  }

  async createConversationRecord(
    agentId: string,
    input: {
      summary?: string;
      description?: string;
      model?: string;
      model_settings?: Record<string, unknown>;
      context_window?: number | null;
      hidden?: boolean;
    } = {},
  ): Promise<unknown> {
    try {
      const modelSettings = input.model_settings ?? this.runtime.model_settings;
      const contextWindow = input.context_window ?? this.runtime.default_context_window;
      return await this.client.conversations.create({
        agentId,
        summary: input.summary ?? this.runtime.conversation_summary,
        description: input.description ?? this.runtime.conversation_description,
        ...(input.model ?? this.defaultModel ? { model: input.model ?? this.defaultModel } : {}),
        ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
        ...(contextWindow !== null ? { contextWindowLimit: contextWindow } : {}),
        hidden: input.hidden ?? this.runtime.conversation_hidden,
      } as never);
    } catch (error) {
      throw toEvaError(error, `creating a conversation for ${agentId}`);
    }
  }

  async updateConversation(
    conversationId: string,
    input: {
      summary?: string;
      description?: string;
      model?: string;
      model_settings?: Record<string, unknown>;
      context_window?: number | null;
      archived?: boolean;
    },
  ): Promise<unknown> {
    this.closeSession(conversationId);
    try {
      return await this.client.conversations.update(conversationId, {
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.model_settings !== undefined ? { modelSettings: input.model_settings } : {}),
        ...(input.context_window !== undefined
          ? { contextWindowLimit: input.context_window }
          : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      } as never);
    } catch (error) {
      throw toEvaError(error, `updating conversation ${conversationId}`);
    }
  }

  /** Open a brand new conversation and return its id. */
  async createConversation(agentId: string): Promise<string> {
    try {
      const conversation = await this.createConversationRecord(agentId) as { id?: string };
      const conversationId = conversation.id;
      if (!conversationId) {
        throw toEvaError(new Error("app server returned no conversation id"), "creating a conversation");
      }
      this.logger.info("created conversation", { agentId, conversationId });
      return conversationId;
    } catch (error) {
      throw toEvaError(error, "creating a conversation");
    }
  }

  // -----------------------------------------------------------------
  // sessions
  // -----------------------------------------------------------------

  /**
   * Resume (or reuse) the session for a conversation.
   *
   * After an App Server or service restart the in-memory pool is empty; the
   * first turn re-opens the conversation and calls bootstrapState() +
   * recoverPendingApprovals() so a turn interrupted by the restart does not
   * hang forever.
   */
  private async acquireSession(conversationId: string): Promise<LettaCodeSession> {
    return (await this.acquirePooled(conversationId)).session;
  }

  async recoverConversationApprovals(conversationId: string): Promise<void> {
    await this.acquireSession(conversationId);
  }

  /**
   * Сессия вместе с её учётной записью в пуле.
   *
   * Ход берёт именно её, а не голую сессию: счётчик активных ходов
   * живёт здесь, и без него закрытие не отличает занятую сессию от
   * простаивающей.
   */
  private async acquirePooled(conversationId: string, turnPolicy?: { allowedTools: readonly string[]; canUseTool: CanUseToolCallback }): Promise<PooledSession> {
    if (turnPolicy && this.sessions.has(conversationId)) this.closeSession(conversationId);
    const pooled = this.sessions.get(conversationId);
    if (pooled && !pooled.closing) {
      pooled.lastUsedAt = Date.now();
      return pooled;
    }
    if (pooled?.closing) {
      // Сессия уходит: дождаться её мы не можем, а переиспользовать
      // нельзя. Новый ход получит новую сессию, старая закроется, когда
      // её ход закончится. Если её уже никто не держит — закрываем
      // прямо здесь: иначе объект сессии утёк бы вместе с соединением.
      this.sessions.delete(conversationId);
      if (pooled.activeTurns === 0) {
        try {
          pooled.session.close();
        } catch {
          // Закрытие уходящей сессии не должно мешать новому ходу.
        }
      }
    }

    this.evictIdleSessions();

    let session: LettaCodeSession;
    try {
      session = await this.openSession(conversationId, turnPolicy);
    } catch (error) {
      throw toEvaError(error, `resuming conversation ${conversationId}`);
    }

    const entry: PooledSession = {
      session,
      conversationId,
      lastUsedAt: Date.now(),
      recovered: true,
      activeTurns: 0,
      closing: false,
      shardId: SHARD_ID,
    };
    this.sessions.set(conversationId, entry);
    return entry;
  }

  /**
   * Открыть сессию, при необходимости отказавшись от уровня reasoning.
   *
   * SDK применяет `reasoningEffort` при инициализации сессии, а не на ходе:
   * если у модели нет соответствующей записи в каталоге, инициализация
   * бросает исключение и разговор становится недоступен целиком. Настройка
   * из `sdk_settings` не вправе выключать Еву, поэтому такой отказ один раз
   * пишется в журнал, а сессия переоткрывается без reasoning.
   *
   * Повторная попытка делается ровно один раз и только на этот отказ: если
   * переоткрытие тоже не удалось, ошибка уходит наверх как есть.
   */
  private async openSession(conversationId: string, turnPolicy?: { allowedTools: readonly string[]; canUseTool: CanUseToolCallback }): Promise<LettaCodeSession> {
    const options = await this.sessionOptions(conversationId, turnPolicy);
    // Продуктовые инструменты выполняются в процессе SDK, и обратно их
    // называет не всякий транспорт. Что именно передано этой сессии —
    // факт о ней, и готовность вправе на него опереться.
    this.lastClientTools = (options.tools ?? []).map((tool) => tool.name);
    const session = this.client.resumeSession(conversationId, options);
    try {
      await this.hydrate(session, conversationId);
      return session;
    } catch (error) {
      // Уровень уже отвергнут и потому не передавался — значит дело не в
      // нём. И наоборот: пока reasoning не передаётся, переоткрывать нечего.
      if (this.unsupportedReasoningEffort !== null || !this.usesReasoningEffort()) throw error;
      if (!isReasoningTierError(error)) throw error;
      try {
        session.close();
      } catch {
        // Неинициализированная сессия могла и не открыть соединение.
      }
      this.unsupportedReasoningEffort = this.runtime.reasoning_effort;
      this.logger.warn("модель не предлагает выбранный уровень reasoning, ход идёт без него", {
        reasoning_effort: this.runtime.reasoning_effort,
        model: this.defaultModel,
      });
      const retry = this.client.resumeSession(
        conversationId,
        await this.sessionOptions(conversationId, turnPolicy),
      );
      await this.hydrate(retry, conversationId);
      return retry;
    }
  }

  /** Передаётся ли уровень reasoning в опции сессии прямо сейчас. */
  private usesReasoningEffort(): boolean {
    return (
      this.runtime.reasoning_effort !== "none" &&
      this.runtime.reasoning_effort !== this.unsupportedReasoningEffort
    );
  }

  /**
   * Привести сессию в рабочее состояние документированным путём.
   *
   * `bootstrapState()` — публичная гидратация сессии: она поднимает
   * соединение и применяет опции, поэтому её отказ означает, что сессия
   * непригодна, и уходит наверх. На ней же виден отказ каталога в
   * уровне reasoning — его разбирает `openSession()`.
   *
   * Восстановление подтверждений — иное дело: у нового разговора
   * восстанавливать нечего, и его отказ ход не отменяет.
   */
  private async hydrate(session: LettaCodeSession, conversationId: string): Promise<void> {
    const state = await session.bootstrapState();
    // Открытие сессии — самый дешёвый момент, когда runtime говорит о
    // себе правду: состав инструментов приходит с гидратацией, а
    // рабочий каталог памяти, режим разрешений и связь с устройством —
    // одним запросом состояния. Готовность считается по ним, и на ходу
    // за это платить уже не нужно.
    this.recordSessionFacts(state, session);
    try {
      const recovery = await session.recoverPendingApprovals();
      if (recovery?.recovered) {
        this.logger.warn("recovered a pending approval after a restart", { conversationId });
      }
    } catch (error) {
      this.logger.debug("approval recovery skipped", {
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Вытеснение простаивающих сессий.
   *
   * Активная сессия не вытесняется ни по времени простоя, ни по LRU: с
   * включённым безопасным менеджером счётчик активных ходов — это
   * запрет, а не подсказка. Если свободных сессий нет вовсе, пул
   * временно перерастает свой размер: пережить лишнюю сессию дешевле,
   * чем оборвать чужой ход.
   */
  private evictIdleSessions(): void {
    const now = Date.now();
    for (const [id, pooled] of this.sessions) {
      if (this.safeSessions && pooled.activeTurns > 0) continue;
      if (now - pooled.lastUsedAt > this.runtime.session_idle_ms) {
        this.closeSession(id);
      }
    }
    while (this.sessions.size >= this.runtime.session_pool_size) {
      let oldestId: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [id, pooled] of this.sessions) {
        if (this.safeSessions && pooled.activeTurns > 0) continue;
        if (pooled.lastUsedAt < oldestAt) {
          oldestAt = pooled.lastUsedAt;
          oldestId = id;
        }
      }
      if (!oldestId) break;
      this.closeSession(oldestId);
    }
  }

  /**
   * Закрыть сессию, которую уже попросили уйти и которая освободилась.
   * Вызывается из `finally` хода: именно здесь отложенное закрытие
   * наконец происходит.
   */
  private closeIfDrained(pooled: PooledSession): void {
    if (!pooled.closing || pooled.activeTurns > 0) return;
    const current = this.sessions.get(pooled.conversationId);
    // Сессию могли уже подменить новой: закрываем свою, а не чужую.
    if (current === pooled) this.sessions.delete(pooled.conversationId);
    try {
      pooled.session.close();
    } catch (error) {
      this.logger.debug("closing a drained session failed", {
        conversationId: pooled.conversationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Дождаться, пока сессии освободятся, и закрыть их.
   *
   * Смена настроек SDK и остановка сервиса пользуются этим, а не
   * немедленным закрытием: настройки применяются к следующему ходу, а
   * текущий имеет право договорить. По истечении срока оставшиеся
   * сессии закрываются силой — ждать бесконечно тоже нельзя.
   */
  async drainSessions(timeoutMs: number): Promise<{ drained: number; forced: number }> {
    // Сила применяется только к тем сессиям, которые были в пуле на
    // входе. Ход, начавшийся во время окна, получает новую сессию — и
    // закрывать её на дедлайне значило бы оборвать ход, которому окно
    // ещё ничего не обещало.
    const initial = new Set<PooledSession>();
    for (const pooled of this.sessions.values()) {
      pooled.closing = true;
      initial.add(pooled);
    }
    // Сессия опознаётся объектом, а не conversation: пока идёт окно, под
    // тем же ключом успевает появиться новая сессия. Считать её той же
    // значило бы закрывать уже закрытую по кругу и ждать полного срока
    // там, где ждать больше нечего.
    const stillPooled = (pooled: PooledSession): boolean =>
      this.sessions.get(pooled.conversationId) === pooled;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let drained = 0;
    while (Date.now() < deadline) {
      for (const pooled of initial) {
        if (pooled.activeTurns === 0 && stillPooled(pooled)) {
          this.closeIfDrained(pooled);
          drained += 1;
        }
      }
      if ([...initial].every((pooled) => !stillPooled(pooled))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    let forced = 0;
    for (const pooled of initial) {
      if (!stillPooled(pooled)) continue;
      forced += 1;
      pooled.activeTurns = 0;
      this.closeIfDrained(pooled);
    }
    if (forced > 0) {
      this.logger.warn("Сессии закрыты по истечении срока ожидания", { forced });
    }
    return { drained, forced };
  }

  /**
   * Закрыть сессию. Занятая ходом сессия помечается уходящей и
   * закрывается сама, когда ход закончится: `false` означает «просьба
   * принята, но не выполнена прямо сейчас».
   */
  closeSession(conversationId: string): boolean {
    const pooled = this.sessions.get(conversationId);
    if (!pooled) return true;
    if (this.safeSessions && pooled.activeTurns > 0) {
      pooled.closing = true;
      this.logger.debug("Закрытие сессии отложено до конца хода", {
        conversationId,
        activeTurns: pooled.activeTurns,
      });
      return false;
    }
    this.sessions.delete(conversationId);
    try {
      pooled.session.close();
    } catch (error) {
      this.logger.debug("closing a session failed", {
        conversationId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  /**
   * Инвалидировать runtime только для conversations конкретного агента.
   * Обычно достаточно списка, который вернул recompile; проверка agentId
   * также закрывает его уже открытый default/скрытый conversation, если он
   * не попал в административную выдачу.
   */
  invalidateAgentSessions(agentId: string, conversationIds: readonly string[] = []): void {
    const related = new Set(conversationIds);
    for (const [conversationId, pooled] of this.sessions) {
      if (related.has(conversationId) || pooled.session.agentId === agentId) {
        if (pooled.activeTurns > 0) {
          pooled.closing = true;
        } else {
          this.closeSession(conversationId);
        }
      }
    }
  }

  /** Drain this agent's sessions without ever forcing an active turn closed. */
  async prepareAgentMaintenance(agentId: string): Promise<boolean> {
    const related = [...this.sessions.values()].filter(
      (pooled) => pooled.session.agentId === agentId,
    );
    for (const pooled of related) pooled.closing = true;
    const deadline = Date.now() + Math.max(0, this.drainTimeoutMs);
    while (Date.now() < deadline) {
      for (const pooled of related) this.closeIfDrained(pooled);
      if (related.every((pooled) => pooled.activeTurns === 0)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return related.every((pooled) => pooled.activeTurns === 0);
  }

  get openSessions(): number {
    return this.sessions.size;
  }

  /**
   * Отпечаток действующего промпта: персона плюс системный промпт.
   *
   * Реестра версий промптов в проекте нет, и заводить его этот шаг не
   * вправе. Отпечаток решает ту же задачу для записи хода: два хода с
   * разным значением выполнялись с разными инструкциями. Сам текст
   * промпта из отпечатка не восстанавливается.
   */
  /**
   * Чем сессия оказалась на самом деле.
   *
   * Настройка — это намерение, а init-сообщение сессии — факт: MemFS,
   * источники навыков, набор инструментов и рефлексию отдаёт сам
   * runtime. Их и показываем — иначе выключенный MemFS выглядел бы
   * включённым ровно до первого вопроса о памяти.
   */
  get runtimeFacts(): LettaRuntimeFacts | null {
    return this.lastRuntimeFacts;
  }

  get sessionFacts(): LettaSessionFacts | null {
    return this.lastSessionFacts;
  }

  /**
   * Всё, что runtime сообщил о себе: и на открытии сессии, и в
   * init-сообщении хода. Пустое поле означает «не наблюдали», а не
   * «выключено» — разница существенная, и додумывать её нельзя.
   */
  get observedRuntime(): ObservedRuntime {
    const init = this.lastRuntimeFacts;
    const session = this.lastSessionFacts;
    return {
      tools: session?.tools ?? init?.tools ?? null,
      clientTools: session?.clientTools ?? [],
      memoryDirectory: session?.memoryDirectory ?? null,
      isOnline: session?.isOnline ?? null,
      permissionMode: session?.permissionMode ?? null,
      dreaming: init?.dreaming ? { trigger: init.dreaming.trigger } : null,
      skillSources: init?.skillSources ?? null,
      model: session?.model ?? init?.model ?? null,
      observedAt: session?.observedAt ?? init?.observedAt ?? null,
    };
  }

  /**
   * Готова ли Ева работать.
   *
   * Не то же самое, что «App Server отвечает»: с выключенным MemFS или
   * без нативных инструментов памяти он отвечает так же. Проверка идёт
   * по наблюдённым фактам и по каталогу моделей; сессию она не открывает
   * и хода модели не тратит.
   */
  async readiness(productTools: string[]): Promise<ReadinessReport> {
    const ping = await this.ping();
    return evaluateReadiness(this.observedRuntime, {
      productTools,
      dreamingTrigger: typeof this.runtime.dreaming.trigger === "string"
        ? this.runtime.dreaming.trigger
        : null,
      permissionMode: this.runtime.permissionMode,
      modelCatalogSize: ping.ok ? ping.models : null,
    });
  }

  private recordSessionFacts(
    state: { tools?: string[]; model?: string } | undefined,
    session: LettaCodeSession,
  ): void {
    const facts: LettaSessionFacts = {
      tools: state?.tools ? [...state.tools] : null,
      clientTools: [...this.lastClientTools],
      model: state?.model ?? null,
      memoryDirectory: null,
      workingDirectory: null,
      permissionMode: null,
      isOnline: null,
      observedAt: new Date().toISOString(),
    };
    this.lastSessionFacts = facts;
    // Состояние устройства — отдельный вызов протокола, и не всякий
    // транспорт его предлагает. Нет метода — факты просто остаются
    // ненаблюдёнными, и готовность честно об этом скажет.
    if (typeof session.getDeviceStatus !== "function") return;
    // Состояние устройства спрашивается отдельно и не задерживает ход:
    // сессия уже пригодна, а отказ этого запроса означает лишь, что
    // готовность останется ненаблюдённой.
    void session.getDeviceStatus()
      .then((status) => {
        this.lastSessionFacts = {
          ...facts,
          memoryDirectory: status.memoryDirectory ?? null,
          workingDirectory: status.workingDirectory ?? null,
          permissionMode: status.permissionMode ?? null,
          isOnline: status.isOnline ?? null,
          observedAt: new Date().toISOString(),
        };
        if (!status.memoryDirectory) {
          this.logger.warn("runtime не сообщил каталог памяти агента: MemFS может быть выключен");
        }
      })
      .catch((error: unknown) => {
        this.logger.debug("состояние устройства недоступно", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private recordRuntimeFacts(message: SDKMessage & { type: "init" }): void {
    const facts: LettaRuntimeFacts = {
      model: message.model,
      memfsEnabled: message.memfsEnabled ?? null,
      skillSources: message.skillSources ? [...message.skillSources] : null,
      tools: message.tools ? [...message.tools] : null,
      dreaming: message.dreaming ?? null,
      observedAt: new Date().toISOString(),
    };
    const changed = JSON.stringify({ ...facts, observedAt: "" })
      !== JSON.stringify({ ...(this.lastRuntimeFacts ?? {}), observedAt: "" });
    this.lastRuntimeFacts = facts;
    // Журнал пишется только на изменение: init приходит на каждой новой
    // сессии, а состав возможностей меняется раз в развёртывание.
    if (!changed) return;
    this.logger.info("Letta runtime", {
      model: facts.model,
      memfs: facts.memfsEnabled,
      skill_sources: facts.skillSources,
      tool_count: facts.tools?.length ?? null,
      dreaming: facts.dreaming?.trigger ?? null,
    });
    if (facts.memfsEnabled === false) {
      this.logger.warn("MemFS выключен на стороне runtime: файловая память агента недоступна");
    }
  }

  get promptVersion(): string {
    return createHash("sha256")
      .update(this.persona)
      .update(this.systemPrompt)
      .update(" ")
      .digest("hex")
      .slice(0, 12);
  }

  /**
   * Сессии для /metrics: занятые ходом прямо сейчас и открытые, но
   * простаивающие. Разделение важно операционно — пул, целиком занятый
   * ходами, и пул, целиком простаивающий, требуют разных решений, а по
   * одному числу они неотличимы.
   */
  sessionStats(): { active: number; idle: number } {
    const active = this.runningTurns.size;
    return { active, idle: Math.max(0, this.sessions.size - active) };
  }

  // -----------------------------------------------------------------
  // turns
  // -----------------------------------------------------------------

  /**
   * Run one turn and return the collapsed result.
   *
   * The SDK streams; we consume the stream to completion (or until the turn
   * timeout) and return a single object. `onDelta` lets a caller forward
   * incremental text — used by the streaming endpoint.
   */
  async runTurn(
    conversationId: string,
    message: SendMessage,
    options: {
      /**
       * Срезы ответа по мере генерации. Вызывается синхронно из потока:
       * обработчик не должен ждать сети — иначе он тормозит саму
       * генерацию. Доставка наружу разбирается с этим сама.
       */
      onDelta?: (delta: AssistantDelta) => void;
      /**
       * Барьер отмены. Спрашивается по ходу потока — не чаще раза в
       * `cancelPollMs`: отмена приходит извне, и узнать о ней можно
       * только спросив, но спрашивать на каждом событии значило бы
       * добавить запрос к базе на каждый токен. Ответ
       * `true` останавливает генерацию и стриминг — поздний ответ
       * пользователю не уходит.
       */
      isCancelled?: () => Promise<boolean>;
      /**
       * Как часто спрашивать барьер. Вынесено параметром, чтобы тест
       * проверял сам барьер, а не выдержку между опросами.
       */
      cancelPollMs?: number;
      allowedTools?: readonly string[];
      canUseTool?: CanUseToolCallback;
    } = {},
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const pooled = await this.acquirePooled(conversationId, options.allowedTools === undefined ? undefined : {
      allowedTools: options.allowedTools,
      canUseTool: options.canUseTool ?? ((toolName) => options.allowedTools!.includes(toolName)
        ? { behavior: "allow", updatedInput: {} }
        : { behavior: "deny", message: `Tool ${toolName} is outside the job allowlist` }),
    });
    const sessionAcquireMs = Date.now() - startedAt;
    const session = pooled.session;
    const collected: SDKMessage[] = [];
    let lastCancelCheck = 0;
    let cancelled = false;
    // Ключ последнего сообщения ассистента и его номер — тем же способом,
    // каким поток разбирает `summarizeStream`: `otid` — идентификатор
    // среза, `uuid` — сообщения, и смена ключа означает новое сообщение.
    let deltaKey: string | null = null;
    let deltaGroup = -1;
    let firstDeltaAt: number | null = null;
    let sentAt = startedAt;
    this.runningTurns.add(conversationId);
    // Счётчик поднимается до первого обращения к сессии и опускается в
    // finally: между этими точками сессию не вытеснит ни LRU, ни смена
    // настроек SDK.
    pooled.activeTurns += 1;

    try {
      await session.send(message);
      sentAt = Date.now();

      const stream = session.stream();
      const deadline = startedAt + this.runtime.turn_timeout_ms;

      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          await session.abort().catch(() => undefined);
          throw turnTimeout(`the agent did not finish within ${this.runtime.turn_timeout_ms} ms`);
        }

        const next = await withTimeout(stream.next(), remaining);
        if (next.done) break;

        // Барьер отмены стоит до накопления сообщения: отменённый ход
        // не должен ни дособрать ответ, ни отдать его наружу.
        //
        // Спрашивается не чаще раза в CANCEL_POLL_MS: событий потока
        // сотни, и отдельный запрос к базе на каждое превратил бы
        // барьер в основной источник нагрузки. Задержка обнаружения
        // отмены при этом ограничена той же величиной.
        const now = Date.now();
        const pollMs = options.cancelPollMs ?? CANCEL_POLL_MS;
        if (options.isCancelled && now - lastCancelCheck >= pollMs) {
          lastCancelCheck = now;
          cancelled = await options.isCancelled();
        }
        if (cancelled) {
          await session.abort().catch(() => undefined);
          throw turnCancelled(`ход в ${conversationId} отменён`);
        }

        const sdkMessage = next.value as SDKMessage;
        collected.push(sdkMessage);

        if (sdkMessage.type === "assistant") {
          const raw = sdkMessage as { content?: unknown; uuid?: string; otid?: string | null };
          const text = extractText(raw.content);
          if (text) {
            if (firstDeltaAt === null) firstDeltaAt = Date.now();
            const key: string = raw.otid ?? raw.uuid ?? deltaKey ?? "single";
            const startsGroup = deltaGroup < 0 || key !== deltaKey;
            if (startsGroup) deltaGroup += 1;
            deltaKey = key;
            options.onDelta?.({ text, group: deltaGroup, startsGroup });
          }
        }
        if (sdkMessage.type === "init") this.recordRuntimeFacts(sdkMessage);
        if (sdkMessage.type === "error") {
          const detail = (sdkMessage as { message?: string; error?: string });
          throw toEvaError(
            new Error(detail.message ?? detail.error ?? "the agent reported an error"),
            "running a turn",
          );
        }
        if (sdkMessage.type === "result") break;
      }
    } catch (error) {
      // Отмена — не поломка: сессия здорова, её просто попросили
      // остановиться. Закрывать её значило бы платить за отмену
      // переподключением на следующем ходе того же человека.
      if (error instanceof EvaError && error.code === "turn_cancelled") throw error;
      // Повреждённая сессия не остаётся в пуле — но закрывается только
      // она одна и только после того, как её ход отпустит счётчик.
      pooled.closing = true;
      throw toEvaError(error, "running a turn");
    } finally {
      this.runningTurns.delete(conversationId);
      pooled.activeTurns = Math.max(0, pooled.activeTurns - 1);
      this.closeIfDrained(pooled);
    }

    const summary = summarizeStream(collected);
    return {
      ...summary,
      agentId: session.agentId ?? "",
      conversationId: session.conversationId ?? conversationId,
      durationMs: Date.now() - startedAt,
      sessionAcquireMs,
      firstDeltaMs: firstDeltaAt === null ? null : firstDeltaAt - sentAt,
    };
  }

  /**
   * Попросить Letta сжать историю conversation её собственной командой.
   *
   * Это не свой compaction: Evaself не решает, когда сжимать, и в
   * обычном ходу этот метод не вызывается. Он существует ради проверки
   * — доказать, что память переживает настоящее сжатие, можно только
   * если сжатие действительно произошло, — и ради явного действия
   * человека в административной панели.
   */
  async requestCompaction(conversationId: string): Promise<{ ok: boolean; detail: unknown }> {
    const session = await this.acquireSession(conversationId);
    try {
      const response = await session.sendCommand<{
        type: string; success?: boolean; compaction?: unknown; error?: string;
      }>(
        {
          type: "conversation_compact",
          request_id: randomUUID(),
          conversation_id: conversationId,
        },
        { responseType: "conversation_compact_response" },
      );
      return {
        ok: response.success === true,
        detail: response.success === true ? response.compaction : response.error ?? null,
      };
    } catch (error) {
      throw toEvaError(error, `compacting conversation ${conversationId}`);
    }
  }

  async listMessages(conversationId: string, limit = 50): Promise<ListMessagesResult> {
    const session = await this.acquireSession(conversationId);
    try {
      return await session.listMessages({ limit, order: "desc" });
    } catch (error) {
      throw toEvaError(error, "listing messages");
    }
  }

  async listModels(): Promise<unknown> {
    try {
      return await this.client.models.list();
    } catch (error) {
      throw appServerUnavailable(
        `cannot list models: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Interrupt an active turn without deleting its conversation or memory. */
  async abortTurn(conversationId: string): Promise<{ aborted: boolean }> {
    const pooled = this.sessions.get(conversationId);
    if (!pooled) return { aborted: false };
    try {
      await pooled.session.abort();
      this.closeSession(conversationId);
      return { aborted: true };
    } catch (error) {
      this.closeSession(conversationId);
      throw toEvaError(error, `aborting conversation ${conversationId}`);
    }
  }

  /** Runtime state is available only for an already opened SDK session. */
  async sessionStatus(conversationId: string): Promise<Record<string, unknown>> {
    const pooled = this.sessions.get(conversationId);
    if (!pooled) return { open: false, conversation_id: conversationId };
    try {
      const status = await pooled.session.getDeviceStatus({
        timeoutMs: Math.min(this.runtime.app_server_request_timeout_ms, 15_000),
      });
      return {
        open: true,
        conversation_id: conversationId,
        agent_id: pooled.session.agentId,
        session_id: pooled.session.sessionId,
        last_used_at: new Date(pooled.lastUsedAt).toISOString(),
        ...status,
      };
    } catch (error) {
      return {
        open: true,
        conversation_id: conversationId,
        status_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Prove that the restarted App Server has discovered the selected model.
   * A generic protocol ping is insufficient: the dynamic model catalog may
   * still be refreshing, or the configured endpoint may not expose this ID.
   */
  async waitForModel(handle: string, attempts = 20): Promise<void> {
    let available: string[] = [];
    let lastError = "";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const catalog = await this.client.models.list();
        available = [
          ...(catalog.availableHandles ?? []),
          ...catalog.entries
            .map((entry) => entry.handle)
            .filter((entry): entry is string => typeof entry === "string"),
        ];
        if (available.includes(handle)) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    const suffix = lastError
      ? ` Последняя ошибка каталога: ${lastError}`
      : available.length > 0
        ? ` Доступны: ${[...new Set(available)].slice(0, 20).join(", ")}`
        : " App Server вернул пустой каталог.";
    throw new Error(`Модель ${handle} не появилась в каталоге App Server.${suffix}`);
  }

  /**
   * App Server SDK 0.5.x applies client-side tool policy and runtime controls
   * when a conversation session is opened, not while the persistent agent is
   * created. Keeping that distinction here prevents unsupported create-agent
   * fields from being silently saved but never enforced.
   */
  private async sessionOptions(conversationId: string, turnPolicy?: { allowedTools: readonly string[]; canUseTool: CanUseToolCallback }): Promise<LettaCodeClientSessionOptions> {
    // Разрешение сессии загружает MCP-инструменты этой conversation, и
    // потому выполняется до снимка фабрики инструментов SDK.
    const approval = this.sessionApprovalResolver
      ? await this.sessionApprovalResolver(conversationId)
      : null;
    const tools = this.toolFactory?.(conversationId) ?? [];
    return {
      // The remote path belongs to the self-hosted App Server container.
      // compose mounts versioned project skills at /data/letta/.skills,
      // which is the directory Letta Code discovers for source "project".
      cwd: "/data/letta",
      permissionMode: this.runtime.permissionMode,
      // "none" is our explicit UI/default value. Passing it to the SDK asks
      // the model catalog for a literal "none" tier, which ordinary
      // OpenAI-compatible models do not advertise. Omitting the option keeps
      // the provider's non-reasoning/default model unchanged. Уровень, уже
      // отвергнутый каталогом, тоже не передаётся: см. openSession().
      ...(this.usesReasoningEffort()
        ? { reasoningEffort: this.runtime.reasoning_effort }
        : {}),
      dreaming: this.runtime.dreaming as LettaCodeClientSessionOptions["dreaming"],
      // Продуктовые инструменты Evaself регистрируются, и на этом участие
      // Evaself в наборе инструментов заканчивается. `allowedTools` не
      // передаётся намеренно: он задаёт ТОЧНЫЙ список клиентских
      // инструментов сессии, и любой такой список вычёркивает штатные —
      // память, Skill, субагентов, обращение к истории.
      ...(tools.length > 0 ? { tools } : {}),
      ...(turnPolicy?.allowedTools ? { allowedTools: [...turnPolicy.allowedTools] } : {}),
      ...(turnPolicy?.canUseTool ? { canUseTool: turnPolicy.canUseTool } : approval ? { canUseTool: approval } : {}),
    };
  }

  /** Inventory every live App Server agent, including agents created only in WebUI. */
  async listAllModelMappings(): Promise<Array<{ agentId: string; conversationIds: string[] }>> {
    const agents = await this.listAgents() as Array<{ id?: string }>;
    const mappings: Array<{ agentId: string; conversationIds: string[] }> = [];
    for (const agent of agents) {
      if (!agent.id) continue;
      const conversations = await this.listConversations(agent.id) as Array<{ id?: string }>;
      mappings.push({
        agentId: agent.id,
        conversationIds: conversations
          .map((conversation) => conversation.id)
          .filter((id): id is string => Boolean(id)),
      });
    }
    return mappings;
  }

  async applyModelToMappings(
    mappings: Array<{ agentId: string; conversationIds: string[] }>,
    model: string,
    contextWindow: number,
    modelSettings?: Record<string, unknown>,
  ): Promise<void> {
    this.closeAllSessions();
    for (const mapping of mappings) {
      try {
        await this.client.agents.update(mapping.agentId, {
          model,
          contextWindowLimit: contextWindow,
          ...(modelSettings ? { modelSettings } : {}),
        } as never);
        for (const conversationId of mapping.conversationIds) {
          await this.client.conversations.update(conversationId, {
            model,
            contextWindowLimit: contextWindow,
            ...(modelSettings ? { modelSettings } : {}),
          } as never);
        }
      } catch (error) {
        throw toEvaError(error, `updating model for agent ${mapping.agentId}`);
      }
    }
  }

  async getAgent(agentId: string): Promise<unknown> {
    try {
      return await this.client.agents.retrieve(agentId);
    } catch (error) {
      throw toEvaError(error, `retrieving agent ${agentId}`);
    }
  }

  async updateAgent(
    agentId: string,
    input: {
      name?: string;
      description?: string;
      model?: string;
      model_settings?: Record<string, unknown>;
      system?: string;
      tags?: string[];
      hidden?: boolean;
      context_window?: number | null;
    },
  ): Promise<unknown> {
    try {
      this.closeAllSessions();
      return await this.client.agents.update(agentId, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.model_settings !== undefined ? { modelSettings: input.model_settings } : {}),
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
        ...(input.context_window !== undefined
          ? { contextWindowLimit: input.context_window }
          : {}),
      } as never);
    } catch (error) {
      throw toEvaError(error, `updating agent ${agentId}`);
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    try {
      this.closeAllSessions();
      await this.client.agents.delete(agentId);
      this.logger.warn("agent deleted by administrator", { agentId });
    } catch (error) {
      throw toEvaError(error, `deleting agent ${agentId}`);
    }
  }

  async createManagedAgent(input: ManagedAgentInput): Promise<{
    agent: unknown;
    conversation: unknown | null;
  }> {
    const persona = this.persona;
    const human =
      input.human ??
      input.memory?.find((block) => block.label === "human")?.value ??
      "";
    const options: CreateAgentOptions = {
      name: input.name,
      description: input.description ?? this.runtime.default_description,
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      ...(input.personality ? { personality: input.personality as CreateAgentOptions["personality"] } : {}),
      ...(input.embedding ? { embedding: input.embedding } : {}),
      persona,
      human,
      memory: input.memory
        ? ensureCoreMemoryBlocks(input.memory, persona, human).map((block) =>
            block.label === "persona" ? { ...block, value: persona } : block,
          )
        : evaMemoryBlocks(persona, human),
      tags: input.tags ?? this.runtime.default_tags,
      permissionMode: input.permission_mode ?? this.runtime.permissionMode,
      memfs: input.memfs_enabled ?? this.runtime.memfs_enabled,
      dreaming: (input.dreaming ?? this.runtime.dreaming) as DreamingOptions,
      systemPrompt: this.systemPrompt,
      ...((input.base_tools ?? this.runtime.base_tools) !== null
        ? { baseTools: input.base_tools ?? this.runtime.base_tools! }
        : {}),
      ...(input.model ?? this.defaultModel ? { model: input.model ?? this.defaultModel } : {}),
    };

    try {
      const agentId = await this.client.createAgent(options);
      const modelSettings = input.model_settings ?? this.runtime.model_settings;
      const contextWindow = input.context_window ?? this.runtime.default_context_window;
      if (Object.keys(modelSettings).length > 0 || contextWindow !== null) {
        await this.client.agents.update(agentId, {
          ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
          ...(contextWindow !== null ? { contextWindowLimit: contextWindow } : {}),
        } as never);
      }
      const agent = await this.client.agents.retrieve(agentId);
      const shouldCreate = input.create_conversation ?? this.runtime.create_conversation;
      const conversation = shouldCreate
        ? await this.createConversationRecord(agentId)
        : null;
      this.logger.info("created agent from admin API", { agentId });
      return { agent, conversation };
    } catch (error) {
      throw toEvaError(error, "creating an administrative agent");
    }
  }

  /** Close every pooled session; called on SIGTERM. */
  closeAllSessions(): void {
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
  }

  shutdown(): void {
    this.closeAllSessions();
  }

  requireAgent(agentId: string | null | undefined): string {
    if (!agentId) throw notFound("this user has no agent yet");
    return agentId;
  }
}

/**
 * Трасса хода для административного просмотра — только метаданные.
 *
 * Раньше сюда попадало сообщение SDK целиком: текст пользователя,
 * рассуждение модели, аргументы и результаты инструментов. Скрывались
 * только ключи, похожие на секреты, — то есть переписка и рассуждения
 * оседали в ответе браузеру и в любом месте, куда трассу скопируют.
 * Инвариант 19 и правила приватности этого не допускают.
 *
 * Поэтому проекция белого списка: что за событие, к какому ходу и
 * сессии относится, сколько заняло, сколько стоило, чем закончилось.
 * Содержимое не переносится ни на одном уровне вложенности — от него
 * остаются размеры и количества.
 */

/** Скалярные поля события: тип, статус, модель, время, признак ошибки. */
const TRACE_SCALARS = [
  "type", "subtype", "stopReason", "stop_reason", "model", "provider",
  "permissionMode", "behavior", "isError", "is_error", "status", "code",
  "errorCode", "error_code", "durationMs", "duration_ms", "durationApiMs",
  "numTurns", "num_turns", "totalCostUsd",
] as const;

/** Идентификаторы: по ним ход находится в Letta, содержимого в них нет. */
const TRACE_IDENTIFIERS = [
  "uuid", "otid", "runId", "sessionId", "conversationId", "agentId",
  "requestId", "toolCallId", "tool_call_id", "messageId", "parentToolUseId",
] as const;

function traceScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "number" || typeof value === "boolean") return value;
  // Код статуса — короткая строка. Длинная строка на месте кода почти
  // наверняка сообщение с содержанием, и в трассу она не идёт.
  if (typeof value === "string" && value.length <= 200) return value;
  return undefined;
}

/** Размер содержимого без самого содержимого. */
function traceSize(value: unknown): number | undefined {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + (traceSize(item) ?? 0), 0);
  }
  if (value && typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text.length;
    return undefined;
  }
  return undefined;
}

function sanitizeTraceMessage(message: SDKMessage): Record<string, unknown> {
  const raw = message as unknown as Record<string, unknown>;
  const entry: Record<string, unknown> = {};

  for (const key of TRACE_SCALARS) {
    const value = traceScalar(raw[key]);
    if (value !== undefined) entry[key] = value;
  }
  for (const key of TRACE_IDENTIFIERS) {
    if (typeof raw[key] === "string") entry[key] = raw[key];
  }
  if (Array.isArray(raw.runIds)) {
    entry.runIds = raw.runIds.filter((id): id is string => typeof id === "string");
  }

  const toolName = raw.toolName ?? raw.name;
  if (typeof toolName === "string") entry.toolName = toolName;

  // Расход токенов — числа, и только они: у usage бывают вложенные
  // объекты с идентификаторами запросов провайдера.
  if (raw.usage && typeof raw.usage === "object") {
    const usage: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw.usage as Record<string, unknown>)) {
      if (typeof value === "number") usage[key] = value;
    }
    if (Object.keys(usage).length > 0) entry.usage = usage;
  }

  // Счётчики вместо содержимого: по ним видно, что ход шёл и насколько
  // он был велик, но восстановить сказанное нельзя.
  const contentChars = traceSize(raw.content ?? raw.text ?? raw.result);
  if (contentChars !== undefined) entry.contentChars = contentChars;
  const input = raw.toolInput ?? raw.input ?? raw.arguments;
  if (input && typeof input === "object") {
    entry.argumentCount = Object.keys(input as Record<string, unknown>).length;
  }

  return entry;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(turnTimeout(`stream stalled for ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
