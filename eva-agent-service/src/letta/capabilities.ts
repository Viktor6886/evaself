/**
 * Что установленные пакеты Letta действительно умеют — и чем это подтверждено.
 *
 * Реестр существует потому, что версия SDK один раз уже поднялась сама:
 * `@letta-ai/letta-agent-sdk` уехал с 0.5.5 на 0.6.2 групповым обновлением
 * зависимостей, и заметить это было негде — ни один тест не спрашивал у
 * пакета, остались ли на месте методы, на которых держится runtime.
 *
 * Поэтому здесь не описание намерений, а список путей, каждый из которых
 * contract-тест ищет на живом объекте клиента. Строка реестра, которой
 * больше не соответствует метод, валит тест — независимо от того, кто и
 * зачем поднял версию.
 *
 * Операция, которой нет ни в одном пакете, остаётся в реестре со
 * `surface: null` и причиной. Это дешевле, чем каждый раз заново выяснять,
 * почему её нет: отсутствие, записанное явно, не превращается со временем
 * в «кажется, забыли сделать».
 */

import { unsupportedOperation } from "../errors.js";

export const AGENT_SDK_PACKAGE = "@letta-ai/letta-agent-sdk";

/**
 * Версии, на которых реестр подтверждён. Держатся здесь, а не читаются из
 * `package.json`: тест обязан ловить расхождение между тем, что закреплено
 * в lock-файле, и тем, что кто-то проверял руками. Читай версию из пакета —
 * и тест начнёт соглашаться с любым обновлением.
 */
export const VERIFIED_VERSIONS = {
  agentSdk: "0.7.1",
} as const;

/**
 * Где живёт операция.
 *
 * `session` отделён от `agent-sdk` намеренно: методы сессии — это путь
 * выполнения диалога, и смешивать их с управляющими вызовами того же
 * пакета значило бы потерять границу, ради которой административный
 * клиент вообще заведён отдельно.
 */
export type LettaSurface = "agent-sdk" | "session";

/**
 * Как операция проверяется.
 *
 * `method` — путь ищется на объекте клиента и обязан быть функцией.
 * `option` — операция передаётся полем настроек, а не вызовом: в runtime
 * от неё не остаётся ничего, что можно потрогать, потому что типы
 * стираются. Такая строка обязана нести `note`, иначе тест не даст
 * выдать непроверяемое за проверенное.
 */
export type CapabilityCheck = "method" | "option";

export interface LettaCapability {
  /** Стабильный идентификатор. По нему операция запрашивается в коде. */
  readonly id: string;
  /** Человеческое название для матрицы совместимости в отчёте. */
  readonly title: string;
  /** Кем поддержана; `null` — не поддержана ни одним пакетом. */
  readonly surface: LettaSurface | null;
  /** Путь метода внутри клиента; `null` для `option` и для неподдержанных. */
  readonly path: string | null;
  readonly check: CapabilityCheck;
  /** Обязателен для `option` и для неподдержанных операций. */
  readonly note?: string;
}

const CAPABILITIES = [
  // --- агенты: управляющий путь Agent SDK -------------------------------
  {
    id: "agent.create",
    title: "Создание агента",
    surface: "agent-sdk",
    path: "createAgent",
    check: "method",
  },
  {
    id: "agent.list",
    title: "Список агентов",
    surface: "agent-sdk",
    path: "agents.list",
    check: "method",
  },
  {
    id: "agent.retrieve",
    title: "Чтение агента",
    surface: "agent-sdk",
    path: "agents.retrieve",
    check: "method",
  },
  {
    id: "agent.update",
    title: "Изменение агента",
    surface: "agent-sdk",
    path: "agents.update",
    check: "method",
  },
  {
    id: "agent.delete",
    title: "Удаление агента",
    surface: "agent-sdk",
    path: "agents.delete",
    check: "method",
  },

  // --- conversations ----------------------------------------------------
  {
    id: "conversation.create",
    title: "Создание conversation",
    surface: "agent-sdk",
    path: "conversations.create",
    check: "method",
  },
  {
    id: "conversation.list",
    title: "Список conversation",
    surface: "agent-sdk",
    path: "conversations.list",
    check: "method",
  },
  {
    id: "conversation.retrieve",
    title: "Чтение conversation",
    surface: "agent-sdk",
    path: "conversations.retrieve",
    check: "method",
  },
  {
    id: "conversation.update",
    title: "Изменение conversation",
    surface: "agent-sdk",
    path: "conversations.update",
    check: "method",
  },
  {
    id: "conversation.archive",
    title: "Архивирование conversation",
    surface: "agent-sdk",
    path: "conversations.update",
    check: "method",
    note:
      "Отдельного метода архивирования нет: архив — поле `archived` того же " +
      "обновления. Строка заведена, чтобы код не искал несуществующий " +
      "`conversations.archive`.",
  },
  {
    id: "conversation.messages",
    title: "История сообщений conversation",
    surface: "agent-sdk",
    path: "conversations.listMessages",
    check: "method",
  },
  {
    id: "conversation.delete",
    title: "Удаление conversation",
    surface: null,
    path: null,
    check: "method",
    note:
      "В Agent SDK удаления conversation нет вовсе — только архивирование. " +
      "Официальный клиент его умеет, поэтому операция административная.",
  },
  {
    id: "conversation.recompile",
    title: "Пересборка compiled context conversation",
    surface: null,
    path: null,
    check: "method",
    note:
      "Для explicit conversations используется официальный метод клиента 1.12.1; " +
      "Agent SDK 0.7.1 не экспортирует recompile через свой conversations-фасад.",
  },

  // --- ход диалога: сессия ---------------------------------------------
  {
    id: "session.resume",
    title: "Открытие и возобновление сессии",
    surface: "agent-sdk",
    path: "resumeSession",
    check: "method",
  },
  {
    id: "turn.send",
    title: "Отправка сообщения в ход",
    surface: "session",
    path: "send",
    check: "method",
  },
  {
    id: "turn.stream",
    title: "Стриминг хода",
    surface: "session",
    path: "stream",
    check: "method",
  },
  {
    id: "turn.abort",
    title: "Отмена хода",
    surface: "session",
    path: "abort",
    check: "method",
  },
  {
    id: "session.bootstrap",
    title: "Восстановление состояния сессии после перезапуска",
    surface: "session",
    path: "bootstrapState",
    check: "method",
  },
  {
    id: "approvals.recover",
    title: "Восстановление ожидающих approvals",
    surface: "session",
    path: "recoverPendingApprovals",
    check: "method",
  },
  {
    id: "session.messages",
    title: "История сообщений сессии",
    surface: "session",
    path: "listMessages",
    check: "method",
  },
  {
    id: "session.status",
    title: "Состояние устройства сессии",
    surface: "session",
    path: "getDeviceStatus",
    check: "method",
  },

  // --- каталог моделей --------------------------------------------------
  {
    id: "models.list",
    title: "Каталог моделей",
    surface: "agent-sdk",
    path: "models.list",
    check: "method",
  },

  // --- memory blocks: только официальный клиент -------------------------
  {
    id: "memory-block.list",
    title: "Список memory blocks агента",
    surface: null,
    path: null,
    check: "method",
    note: "Не поддерживается Agent SDK для self-hosted WebSocket App Server.",
  },
  {
    id: "memory-block.retrieve",
    title: "Чтение memory block агента",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "memory-block.update",
    title: "Точечное изменение memory block",
    surface: null,
    path: null,
    check: "method",
    note:
      "Единственная официальная запись в блок. В Agent SDK её нет: он умеет " +
      "задать блоки при создании агента и больше не возвращается к ним.",
  },
  {
    id: "memory-block.attach",
    title: "Присоединение блока к агенту",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "memory-block.detach",
    title: "Отсоединение блока от агента",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "memory-block.create",
    title: "Создание отдельного блока",
    surface: null,
    path: null,
    check: "method",
  },

  // --- инструменты и approvals -----------------------------------------
  {
    id: "tool.list",
    title: "Каталог инструментов",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "tool.attach",
    title: "Присоединение инструмента к агенту",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "tool.detach",
    title: "Отсоединение инструмента от агента",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "tool.approval",
    title: "Режим подтверждения инструмента",
    surface: null,
    path: null,
    check: "method",
  },

  // --- окружение агента -------------------------------------------------
  {
    id: "mcp-server.list",
    title: "Список MCP-серверов",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "folder.list",
    title: "Список knowledge folders",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "agent.export",
    title: "Экспорт агента",
    surface: null,
    path: null,
    check: "method",
  },
  {
    id: "agent.import",
    title: "Импорт агента",
    surface: null,
    path: null,
    check: "method",
  },

  // --- то, что задаётся настройкой, а не вызовом ------------------------
  {
    id: "skills.sources",
    title: "Источники навыков",
    surface: "agent-sdk",
    path: null,
    check: "option",
    note:
      "Evaself не передаёт `skillSources` вовсе: умолчание Letta Code — все " +
      "источники (bundled, global, agent, project), и сузить их значит " +
      "выключить часть механизма навыков. Фактический состав приходит в " +
      "init-сообщении сессии и проверяется на живом runtime, а не по типу.",
  },
  {
    id: "session.memfs",
    title: "MemFS агента",
    surface: "agent-sdk",
    path: null,
    check: "option",
    note:
      "Включается полем `memfs` при создании агента и не выключается " +
      "сессией: `stateless` Evaself не передаёт. Фактическое состояние " +
      "приходит в init-сообщении (`memfsEnabled`) — по нему и проверяется.",
  },
  {
    id: "session.dreaming",
    title: "Рефлексия (dreaming)",
    surface: "agent-sdk",
    path: null,
    check: "option",
    note:
      "`dreaming.trigger = compaction-event`: рефлексия идёт на событии " +
      "сжатия контекста. Итоговые настройки приходят в init-сообщении.",
  },
  {
    id: "conversation.purpose",
    title: "Conversation по назначению, включая research",
    surface: "agent-sdk",
    path: null,
    check: "option",
    note:
      "Назначение — понятие Evaself, а не Letta: изолированный conversation " +
      "создаётся обычным `conversations.create`, политику назначения держит " +
      "`src/conversations/purpose-service.ts`. Отдельной операции у пакета " +
      "нет и быть не должно.",
  },

  // --- операций нет ни в одном пакете -----------------------------------
  {
    id: "agent.managed-groups",
    title: "Managed groups",
    surface: null,
    path: null,
    check: "option",
    note:
      "Ни Agent SDK 0.7.1, ни клиент 1.12.1 не дают управления группами. " +
      "Эмулировать прямыми HTTP-запросами к App Server запрещено.",
  },
  {
    id: "memory-block.export-to-memfs",
    title: "Перенос содержимого блока во внешнюю память MemFS",
    surface: null,
    path: null,
    check: "option",
    note:
      "Клиент 1.12.1 не даёт файловой системы агента: среди ресурсов есть " +
      "`agents.passages`, `agents.folders` и `agents.files`, но не MemFS, а " +
      "Agent SDK 0.7.1 работает с ней только изнутри хода, нативными " +
      "инструментами памяти. Официального пути «блок → MemFS» через control " +
      "plane на этих версиях нет, поэтому legacy-блок остаётся " +
      "присоединённым с отметкой legacy_pending_migration. Данные важнее " +
      "схемы: снять блок, не сохранив содержимое, значит потерять память.",
  },
  {
    id: "agent.export-archive",
    title: "Экспорт в YAML, ZIP или .af",
    surface: null,
    path: null,
    check: "option",
    note:
      "`agents.exportFile` отдаёт формат клиента; отдельных YAML/ZIP/`.af` " +
      "выгрузок пакеты не объявляют. Обещать их формату экспорта нельзя.",
  },
] as const satisfies readonly LettaCapability[];

export const LETTA_CAPABILITIES: readonly LettaCapability[] = CAPABILITIES;

export type LettaCapabilityId = (typeof CAPABILITIES)[number]["id"];

const BY_ID = new Map<string, LettaCapability>(
  CAPABILITIES.map((entry) => [entry.id, entry]),
);

export function capability(id: LettaCapabilityId): LettaCapability {
  const found = BY_ID.get(id);
  // Идентификаторы типизированы, поэтому промах возможен только если
  // реестр и тип разошлись — это поломка сборки, а не входных данных.
  if (!found) throw new Error(`неизвестная возможность Letta: ${id}`);
  return found;
}

export function isSupported(id: LettaCapabilityId): boolean {
  return capability(id).surface !== null;
}

/**
 * Остановить путь, которого нет.
 *
 * Вызывается до обращения к пакету: неподдержанная операция обязана
 * выглядеть неподдержанной, а не падать где-то внутри клиента с
 * невнятным `TypeError` или, хуже, возвращать успех, ничего не сделав.
 */
export function assertSupported(id: LettaCapabilityId): LettaCapability {
  const entry = capability(id);
  if (entry.surface === null) {
    throw unsupportedOperation(`Операция «${entry.title}» не поддержана`, {
      operation: entry.id,
      reason: entry.note,
    });
  }
  return entry;
}

/**
 * Найти операции, которых на живом объекте нет.
 *
 * Та же проверка, что делает contract-тест, — и это главное её свойство.
 * Тест доказывает контракт на сборке, а `EVA_LETTA_CONTRACT_VERIFY` включает ту же
 * проверку на живом развёртывании: canary обязан убедиться, что рядом с
 * ним лежит именно проверенный пакет, а не тот, который приехал вместе с
 * обновлением базового образа.
 *
 * `resolve` возвращает значение по пути внутри клиента. Проверяются только
 * операции с `check: "method"`: опция в runtime следа не оставляет.
 */
export function missingCapabilities(
  surface: LettaSurface,
  resolve: (path: string) => unknown,
): LettaCapability[] {
  return LETTA_CAPABILITIES.filter((entry) => {
    if (entry.surface !== surface || entry.check !== "method" || entry.path === null) return false;
    return typeof resolve(entry.path) !== "function";
  });
}

/**
 * Матрица для отчёта и для административного ответа: операция, кем
 * поддержана, в какой версии. Собирается из того же реестра, поэтому
 * разойтись с проверенным поведением не может.
 */
export function capabilityMatrix(): Array<{
  operation: string;
  title: string;
  supported: boolean;
  surface: LettaSurface | null;
  version: string | null;
  note: string | null;
}> {
  return LETTA_CAPABILITIES.map((entry) => ({
    operation: entry.id,
    title: entry.title,
    supported: entry.surface !== null,
    surface: entry.surface,
    version: entry.surface === null ? null : VERIFIED_VERSIONS.agentSdk,
    note: entry.note ?? (entry.surface === null
      ? "Не поддерживается Agent SDK для self-hosted WebSocket App Server; maintenance не блокирует turn."
      : null),
  }));
}
