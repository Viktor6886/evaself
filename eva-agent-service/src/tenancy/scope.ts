/**
 * Граница арендатора: единый контекст, без которого обращение к
 * пользовательским данным не выполняется.
 *
 * Правило одно и оно закрытое: запрос, затрагивающий таблицу из
 * `TENANT_TABLES`, выполняется только внутри объявленной области.
 *
 *   • `user`   — работа от имени одного пользователя. Каждая
 *                пользовательская таблица в запросе обязана быть
 *                ограничена столбцом владельца, а значение этого столбца
 *                обязано совпасть с пользователем области. Подмена
 *                идентификатора в аргументе инструмента, в теле запроса
 *                браузера или в payload задания здесь и отсекается.
 *   • `system` — фоновая работа сервиса: аренда записей inbox и outbox,
 *                выборка задач планировщика, вебхук оплаты. Обращение
 *                сразу к нескольким пользователям требует явного
 *                `crossUser` с причиной.
 *   • `admin`  — административный доступ. Требует роли и записи в
 *                журнале аудита; без записи запрос не выполняется.
 *
 * Область не «прикрепляется» к запросу вручную: она живёт в
 * AsyncLocalStorage и наследуется всем, что запущено внутри неё.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { analyzeSql, isTelegramColumn, type TenantBinding } from "./sql.js";

export interface UserScope {
  kind: "user";
  /** Внутренний `users.id`. Может быть ещё неизвестен до первой выборки. */
  userId: number | null;
  /** Telegram-идентификатор, если работа началась с него. */
  telegramId: number | null;
  label: string;
}

export interface SystemScope {
  kind: "system";
  reason: string;
  /** Разрешён ли доступ к данным более чем одного пользователя. */
  crossUser: boolean;
}

/**
 * Область администратора заполняется по мере проверок запроса, поэтому
 * её поля изменяемы: рамка ставится синхронно в самом начале обработки
 * (иначе она не переживает `await` в хуке), а роль и запись аудита
 * появляются позже. До этого момента данные пользователей закрыты.
 */
export interface AdminScope {
  kind: "admin";
  actor: string;
  role: string;
  /** Идентификатор записи аудита. Без него пользовательские данные закрыты. */
  auditId: string | null;
  route: string;
}

export type TenantScope = UserScope | SystemScope | AdminScope;

export class TenantViolationError extends Error {
  readonly code = "tenant_scope_violation";
  constructor(message: string) {
    super(message);
    this.name = "TenantViolationError";
  }
}

const storage = new AsyncLocalStorage<TenantScope>();

export function currentScope(): TenantScope | undefined {
  return storage.getStore();
}

export function runInScope<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
  return storage.run(scope, work);
}

/**
 * Установить область для текущей асинхронной цепочки без обёртки.
 * Нужно там, где рамку ставит hook веб-сервера, а обработчик остаётся
 * нетронутым.
 */
export function enterScope(scope: TenantScope): void {
  storage.enterWith(scope);
}

/** Идентификатор как число: bigint приходит из драйвера строкой. */
function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return null;
}

export function userScope(input: {
  userId?: number | null;
  telegramId?: number | null;
  label: string;
}): UserScope {
  // Идентификаторы приводятся к числу: `users.id` и `telegram_id` —
  // bigint, и драйвер отдаёт их строкой. Без приведения сверка значения
  // сравнивала бы «1» с 1 и отвергала собственный запрос владельца.
  const userId = numeric(input.userId);
  const telegramId = numeric(input.telegramId);
  if (userId === null && telegramId === null) {
    throw new TenantViolationError(
      `Область пользователя «${input.label}» создана без идентификатора`,
    );
  }
  return { kind: "user", userId, telegramId, label: input.label };
}

export function systemScope(reason: string, options: { crossUser?: boolean } = {}): SystemScope {
  return { kind: "system", reason, crossUser: options.crossUser === true };
}

export function adminScope(input: {
  actor: string;
  role: string;
  auditId?: string | null;
  route: string;
}): AdminScope {
  return {
    kind: "admin",
    actor: input.actor,
    role: input.role,
    auditId: input.auditId ?? null,
    route: input.route,
  };
}

/**
 * Пользователь области, если он уже известен. Внутренний идентификатор
 * появляется после первой канонической выборки: работа с Telegram
 * начинается с `telegram_id`, а `users.id` становится известен позже.
 */
export function bindUserId(userId: number): void {
  const scope = storage.getStore();
  if (!scope || scope.kind !== "user") {
    throw new TenantViolationError(
      "Внутренний идентификатор можно связать только с областью пользователя",
    );
  }
  const value = numeric(userId);
  if (value === null) {
    throw new TenantViolationError(
      `Некорректный идентификатор пользователя: ${String(userId)}`,
    );
  }
  if (scope.userId !== null && scope.userId !== value) {
    throw new TenantViolationError(
      `Область пользователя ${scope.userId} не может быть переназначена на ${value}`,
    );
  }
  scope.userId = value;
}

function expectedValue(scope: UserScope, binding: TenantBinding): number | null {
  return isTelegramColumn(binding.column) ? scope.telegramId : scope.userId;
}

/**
 * Проверка одного запроса. Бросает `TenantViolationError`, если запрос
 * выходит за объявленную границу; молча пропускает всё, что
 * пользовательских таблиц не касается.
 */
export function assertQueryAllowed(sql: string, values: readonly unknown[] = []): void {
  const analysis = analyzeSql(sql);
  if (analysis.uses.length === 0) return;

  const scope = storage.getStore();
  const tables = analysis.uses.map((use) => use.table).join(", ");
  if (!scope) {
    throw new TenantViolationError(
      `Обращение к пользовательским данным (${tables}) вне области арендатора`,
    );
  }

  if (scope.kind === "admin") {
    if (!scope.auditId) {
      throw new TenantViolationError(
        `Административное обращение к пользовательским данным (${tables}) ` +
        `не зафиксировано в аудите: ${scope.route}`,
      );
    }
    return;
  }

  if (scope.kind === "system") {
    if (scope.crossUser) return;
    if (analysis.unscoped.length > 0) {
      throw new TenantViolationError(
        `Системная область «${scope.reason}» не объявила доступ к данным ` +
        `нескольких пользователей, а запрос не ограничен: ${analysis.unscoped.join(", ")}`,
      );
    }
    return;
  }

  if (analysis.unscoped.length > 0) {
    throw new TenantViolationError(
      `Запрос без ограничения по пользователю: ${analysis.unscoped.join(", ")} ` +
      `(область «${scope.label}»)`,
    );
  }

  for (const binding of analysis.bindings) {
    const expected = expectedValue(scope, binding);
    const actual = binding.kind === "parameter"
      ? numeric(values[binding.index - 1])
      : binding.kind === "literal"
        ? binding.value
        : null;
    if (expected === null) {
      // Область знает Telegram-идентификатор, но ещё не связана с
      // внутренним `users.id`. Пропустить сверку значит принять любой
      // `user_id`, поэтому обращение отклоняется: сначала каноническая
      // выборка пользователя и `bindUserId`, потом его данные.
      if (actual !== null && !isTelegramColumn(binding.column)) {
        throw new TenantViolationError(
          `Область «${scope.label}» не связана с внутренним идентификатором, ` +
          `а запрос адресует ${binding.column} = ${actual}`,
        );
      }
      continue;
    }
    if (actual === null) continue;
    if (actual !== expected) {
      throw new TenantViolationError(
        `Значение ${binding.column} = ${actual} не совпадает с пользователем ` +
        `области «${scope.label}» (${expected})`,
      );
    }
  }
}
