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
    };
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
}

function normalizeBlock(row: unknown): AdminMemoryBlock {
  const block = (row ?? {}) as {
    label?: unknown;
    value?: unknown;
    description?: unknown;
    limit?: unknown;
    read_only?: unknown;
  };
  return {
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
