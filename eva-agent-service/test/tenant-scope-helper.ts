/**
 * Обёртка для поддельных баз в тестах.
 *
 * Тесты сервисов не поднимают PostgreSQL, но граница арендатора не
 * должна из-за этого исчезать: поддельная база проходит ту же проверку,
 * что и настоящая, и точно так же отказывает при запросе за пределы
 * области. Благодаря этому «двухпользовательская матрица» проверяет не
 * текст SQL, а именно поведение границы.
 */

import {
  adminScope,
  assertQueryAllowed,
  bindUserId,
  currentScope,
  runInScope,
  systemScope,
  userScope,
} from "../dist/tenancy/index.js";

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryFunction = (sql: string, values?: unknown[]) => Promise<QueryResult>;

export interface FakeDatabase {
  query: QueryFunction;
  transaction<T>(work: (client: { query: QueryFunction }) => Promise<T>): Promise<T>;
  withUserScope<T>(
    input: { userId?: number | null; telegramId?: number | null; label: string; inherit?: boolean },
    work: () => Promise<T>,
  ): Promise<T>;
  withSystemScope<T>(
    reason: string,
    work: () => Promise<T>,
    options?: { crossUser?: boolean; inherit?: boolean },
  ): Promise<T>;
  withAdminScope<T>(
    input: { actor: string; role: string; auditId?: string | null; route: string },
    work: () => Promise<T>,
  ): Promise<T>;
  bindScopeUserId(userId: number): void;
  [key: string]: unknown;
}

/**
 * Добавляет к поддельной базе области арендатора и проверку каждого
 * запроса. Все прочие методы объекта сохраняются как есть.
 */
export function withTenantScopes<T extends { query: QueryFunction }>(
  fake: T,
): T & FakeDatabase {
  const guarded: QueryFunction = async (sql, values = []) => {
    assertQueryAllowed(sql, values);
    return await fake.query(sql, values);
  };
  const database = {
    ...(fake as object),
    query: guarded,
    transaction: async <R>(work: (client: { query: QueryFunction }) => Promise<R>) => {
      const original = (fake as { transaction?: unknown }).transaction;
      if (typeof original !== "function") return await work({ query: guarded });
      return await (original as (
        inner: (client: { query: QueryFunction }) => Promise<R>,
      ) => Promise<R>).call(fake, async (client) =>
        await work({
          query: async (sql, values = []) => {
            assertQueryAllowed(sql, values);
            return await client.query(sql, values);
          },
        }));
    },
    withUserScope: async <R>(
      input: {
        userId?: number | null;
        telegramId?: number | null;
        label: string;
        inherit?: boolean;
      },
      work: () => Promise<R>,
    ) => {
      if (input.inherit && currentScope()) return await work();
      return await runInScope(userScope(input), work);
    },
    withSystemScope: async <R>(
      reason: string,
      work: () => Promise<R>,
      options: { crossUser?: boolean; inherit?: boolean } = {},
    ) => {
      if (options.inherit && currentScope()) return await work();
      return await runInScope(systemScope(reason, options), work);
    },
    withAdminScope: async <R>(
      input: { actor: string; role: string; auditId?: string | null; route: string },
      work: () => Promise<R>,
    ) => await runInScope(adminScope(input), work),
    bindScopeUserId: (userId: number) => bindUserId(userId),
  };
  return database as T & FakeDatabase;
}
