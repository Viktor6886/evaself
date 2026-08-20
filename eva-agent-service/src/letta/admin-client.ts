/**
 * Административный control plane Letta.
 *
 * `@letta-ai/letta-client` разрешён инвариантом 4 только здесь и только как
 * управляющий путь: он умеет то, чего нет в Agent SDK, — прежде всего
 * точечную запись в memory block. Второго пути выполнения диалога он не
 * создаёт, и это не пожелание, а свойство адаптера: у интерфейса нет ни
 * одного метода, которым можно отправить сообщение, открыть сессию или
 * получить поток. Тест это проверяет по списку методов, а не по намерению.
 *
 * Клиент строится лениво. Флаг выключен в подавляющем большинстве
 * окружений, и платить за конструктор HTTP-клиента при каждом старте
 * сервиса незачем; кроме того, неверный адрес не должен ронять загрузку —
 * он должен ломать тот вызов, который его действительно использует.
 *
 * Значения блоков — сырой пользовательский текст. Здесь они проходят
 * насквозь и никуда не логируются: в записи о вызове остаются агент, метка
 * блока и длина значения.
 */

import { toEvaError, unsupportedOperation } from "../errors.js";
import type { Logger } from "../logger.js";

import { type LettaCapabilityId, assertSupported } from "./capabilities.js";

/** Проекция блока, которой пользуется синхронизация. Ничего лишнего. */
export interface AdminMemoryBlock {
  /**
   * Идентификатор блока. Нужен для attach и detach: они адресуют блок по
   * `id`, а не по метке — метка у блока не уникальна в установке.
   */
  id: string;
  label: string;
  value: string;
  description: string | null;
  limit: number | null;
  readOnly: boolean;
}

/**
 * Управляющий путь к Letta.
 *
 * Интерфейс узкий намеренно: он описывает ровно то, что шаг умеет
 * подтвердить contract-тестом и чем пользуется синхронизация блоков.
 * Расширение административных возможностей — предмет следующего шага.
 */
export interface LettaAdminPlane {
  /** Включён ли путь. Выключенный отвечает отказом, а не тишиной. */
  readonly available: boolean;
  listMemoryBlocks(agentId: string): Promise<AdminMemoryBlock[]>;
  updateMemoryBlock(agentId: string, label: string, value: string): Promise<AdminMemoryBlock>;
  /**
   * Создать отдельный блок и присоединить его к агенту.
   *
   * Две официальные операции подряд, а не одна: `blocks.create` заводит
   * блок в установке, `agents.blocks.attach` вешает его на агента.
   * Разделять их наружу незачем — созданный, но не присоединённый блок
   * не нужен никому.
   */
  createMemoryBlock(agentId: string, block: NewMemoryBlock): Promise<AdminMemoryBlock>;
  /**
   * Отсоединить блок от агента, не удаляя сам блок.
   *
   * Detach предпочтительнее delete: содержимое остаётся в установке, и
   * возврат — это ещё один attach, а не восстановление из резервной
   * копии.
   */
  detachMemoryBlock(agentId: string, blockId: string): Promise<void>;
  /**
   * Пересобрать compiled context всех explicit conversations агента.
   * Возвращает их идентификаторы, чтобы runtime закрыл только связанные
   * pooled sessions после успешной пересборки.
   */
  recompileAgentConversations(agentId: string): Promise<string[]>;
}

/** Что нужно, чтобы завести недостающий блок. Значение обязательно. */
export interface NewMemoryBlock {
  label: string;
  value: string;
  description?: string | null;
  limit?: number | null;
}

export interface LettaAdminOptions {
  enabled: boolean;
  /** HTTP-адрес App Server. Пуст — путь считается недоступным. */
  baseUrl: string;
  token: string | null;
  logger: Logger;
}

/**
 * Выключенный путь.
 *
 * Каждый вызов отказывает, называя причину. Молчаливого успеха здесь быть
 * не может: вызывающий обязан отличить «блок записан» от «флаг выключен»,
 * иначе синхронизация отметит как `synced` то, чего не происходило.
 */
export class DisabledAdminPlane implements LettaAdminPlane {
  readonly available = false;
  private readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }

  private refuse(operation: LettaCapabilityId): never {
    throw unsupportedOperation(
      `Административный клиент Letta недоступен: ${this.reason}`,
      { operation, reason: this.reason },
    );
  }

  async listMemoryBlocks(): Promise<AdminMemoryBlock[]> {
    this.refuse("memory-block.list");
  }

  async updateMemoryBlock(): Promise<AdminMemoryBlock> {
    this.refuse("memory-block.update");
  }

  async createMemoryBlock(): Promise<AdminMemoryBlock> {
    this.refuse("memory-block.create");
  }

  async detachMemoryBlock(): Promise<void> {
    this.refuse("memory-block.detach");
  }

  async recompileAgentConversations(): Promise<string[]> {
    this.refuse("conversation.recompile");
  }
}

/** Минимальная форма официального клиента, которой мы пользуемся. */
interface OfficialClient {
  agents: {
    blocks: {
      list(agentId: string): AsyncIterable<unknown> & PromiseLike<unknown>;
      update(
        blockLabel: string,
        params: Record<string, unknown>,
      ): PromiseLike<unknown>;
      attach(blockId: string, params: Record<string, unknown>): PromiseLike<unknown>;
      detach(blockId: string, params: Record<string, unknown>): PromiseLike<unknown>;
    };
  };
  blocks: {
    create(params: Record<string, unknown>): PromiseLike<unknown>;
  };
  conversations: {
    list(
      params: Record<string, unknown>,
    ): PromiseLike<unknown>;
    recompile(
      conversationId: string,
      params: Record<string, unknown>,
    ): PromiseLike<unknown>;
  };
}

type OfficialClientFactory = () => Promise<OfficialClient>;

export class LettaAdminClient implements LettaAdminPlane {
  readonly available = true;
  private readonly options: LettaAdminOptions;
  private readonly factory: OfficialClientFactory;
  private client: OfficialClient | null = null;

  /**
   * `factory` подменяется в тестах: настоящий клиент ходит по HTTP, а
   * проверять здесь нужно поведение адаптера — отказ неподдержанной
   * операции, нормализацию блока, отсутствие утечки значения в логи.
   */
  constructor(options: LettaAdminOptions, factory?: OfficialClientFactory) {
    this.options = options;
    this.factory = factory ?? (() => this.createOfficialClient());
  }

  private async createOfficialClient(): Promise<OfficialClient> {
    const module = (await import("@letta-ai/letta-client")) as unknown as Record<string, unknown>;
    const Ctor = (module.Letta ?? module.default) as new (init: {
      apiKey: string | null;
      baseURL: string;
    }) => OfficialClient;
    return new Ctor({
      apiKey: this.options.token,
      baseURL: this.options.baseUrl,
    });
  }

  private async connect(): Promise<OfficialClient> {
    if (!this.client) this.client = await this.factory();
    return this.client;
  }

  async listMemoryBlocks(agentId: string): Promise<AdminMemoryBlock[]> {
    assertSupported("memory-block.list");
    try {
      const client = await this.connect();
      const page = await client.agents.blocks.list(agentId);
      const rows = Array.isArray(page)
        ? page
        : ((page as { data?: unknown[] }).data ?? []);
      return rows.map((row) => normalizeBlock(row));
    } catch (error) {
      throw toEvaError(error, `reading memory blocks of ${agentId}`);
    }
  }

  async updateMemoryBlock(
    agentId: string,
    label: string,
    value: string,
  ): Promise<AdminMemoryBlock> {
    assertSupported("memory-block.update");
    try {
      const client = await this.connect();
      const updated = await client.agents.blocks.update(label, {
        agent_id: agentId,
        value,
      });
      // В запись попадают агент, метка и длина — но не текст блока.
      this.options.logger.info("memory block updated through the control plane", {
        agentId,
        label,
        valueLength: value.length,
      });
      return normalizeBlock(updated);
    } catch (error) {
      throw toEvaError(error, `updating memory block ${label} of ${agentId}`);
    }
  }

  async createMemoryBlock(agentId: string, block: NewMemoryBlock): Promise<AdminMemoryBlock> {
    assertSupported("memory-block.create");
    assertSupported("memory-block.attach");
    try {
      const client = await this.connect();
      const created = normalizeBlock(await client.blocks.create({
        label: block.label,
        value: block.value,
        ...(block.description ? { description: block.description } : {}),
        ...(block.limit ? { limit: block.limit } : {}),
      }));
      if (!created.id) {
        throw new Error("Letta не вернула идентификатор созданного блока");
      }
      await client.agents.blocks.attach(created.id, { agent_id: agentId });
      // Метка и длина — да, значение — нет: в блоке лежит текст о человеке.
      this.options.logger.info("memory block created and attached", {
        agentId,
        label: block.label,
        valueLength: block.value.length,
      });
      return created;
    } catch (error) {
      throw toEvaError(error, `creating memory block ${block.label} for ${agentId}`);
    }
  }

  async detachMemoryBlock(agentId: string, blockId: string): Promise<void> {
    assertSupported("memory-block.detach");
    try {
      const client = await this.connect();
      await client.agents.blocks.detach(blockId, { agent_id: agentId });
      this.options.logger.info("memory block detached from the agent", { agentId, blockId });
    } catch (error) {
      throw toEvaError(error, `detaching memory block ${blockId} from ${agentId}`);
    }
  }

  async recompileAgentConversations(agentId: string): Promise<string[]> {
    assertSupported("conversation.recompile");
    try {
      const client = await this.connect();
      // conversations.list() возвращает APIPromise<Array<Conversation>>,
      // а не AsyncIterable. После await — готовый массив.
      const rows = (await client.conversations.list({
        agent_id: agentId,
        archive_status: "all",
      })) as Array<{ id?: unknown } | null>;
      const conversationIds: string[] = [];
      for (const row of rows) {
        const id = row?.id;
        if (typeof id === "string" && id.length > 0) conversationIds.push(id);
      }
      for (const conversationId of conversationIds) {
        await client.conversations.recompile(conversationId, { agent_id: agentId });
      }
      this.options.logger.info("agent conversations recompiled through the control plane", {
        agentId,
        conversations: conversationIds.length,
      });
      return conversationIds;
    } catch (error) {
      throw toEvaError(error, `recompiling conversations of ${agentId}`);
    }
  }
}

function normalizeBlock(row: unknown): AdminMemoryBlock {
  const block = (row ?? {}) as {
    id?: unknown;
    label?: unknown;
    value?: unknown;
    description?: unknown;
    limit?: unknown;
    read_only?: unknown;
  };
  return {
    id: typeof block.id === "string" ? block.id : "",
    label: typeof block.label === "string" ? block.label : "",
    value: typeof block.value === "string" ? block.value : "",
    description: typeof block.description === "string" ? block.description : null,
    limit: typeof block.limit === "number" ? block.limit : null,
    readOnly: block.read_only === true,
  };
}

/**
 * Собрать управляющий путь по конфигурации.
 *
 * Выключенный флаг и пустой адрес дают один и тот же результат — путь,
 * который отказывает с названной причиной. Разными их делает только текст
 * причины, и этого достаточно: обе ситуации означают «через control plane
 * ничего не записано».
 */
export function buildAdminPlane(options: LettaAdminOptions): LettaAdminPlane {
  if (!options.enabled) return new DisabledAdminPlane("флаг EVA_LETTA_ADMIN_CLIENT выключен");
  if (!options.baseUrl) return new DisabledAdminPlane("не задан EVA_LETTA_ADMIN_BASE_URL");
  return new LettaAdminClient(options);
}
