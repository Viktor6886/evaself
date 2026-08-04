/**
 * Обёртка над `pg.Pool` для процессов, которые ходят в PostgreSQL мимо
 * класса `Database`: admin-api и llm-router. Обёртка ничего не меняет в
 * поведении пула — она лишь проверяет каждый запрос на границу
 * арендатора перед выполнением.
 */

import type pg from "pg";

import { assertQueryAllowed } from "./scope.js";

type QueryArguments = [unknown, ...unknown[]];

function sqlOf(first: unknown): string {
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "text" in first) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function valuesOf(first: unknown, second: unknown): unknown[] {
  if (Array.isArray(second)) return second;
  if (first && typeof first === "object" && "values" in first) {
    const values = (first as { values?: unknown }).values;
    if (Array.isArray(values)) return values;
  }
  return [];
}

export function guardQuery(args: QueryArguments): void {
  assertQueryAllowed(sqlOf(args[0]), valuesOf(args[0], args[1]));
}

function guardedClient(client: pg.PoolClient): pg.PoolClient {
  return new Proxy(client, {
    get: (target, property) => {
      if (property === "query") {
        return (...args: QueryArguments) => {
          guardQuery(args);
          return Reflect.apply(target.query, target, args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function guardPool(pool: pg.Pool): pg.Pool {
  return new Proxy(pool, {
    get: (target, property) => {
      if (property === "query") {
        return (...args: QueryArguments) => {
          guardQuery(args);
          return Reflect.apply(target.query, target, args);
        };
      }
      if (property === "connect") {
        return async () => guardedClient(await target.connect());
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
