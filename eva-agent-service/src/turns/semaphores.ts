/**
 * Глобальные семафоры слотов хода.
 *
 * Слот — это право занять исполнителя прямо сейчас. Их конечное число, и
 * делятся они не поровну, а по назначению: интерактивный ход человека,
 * ждущего ответа, важнее фонового пересчёта. Раскладка взята из
 * `CLAUDE.md`, раздел «Бюджеты»: при пределе 128 — 104 interactive,
 * 12 background, 8 research и 4 резерва, и не меньше 80% интерактивным.
 *
 * Резерв принадлежит интерактивным ходам и только им. Поэтому он не
 * заведён отдельным классом: интерактивный предел равен своей доле плюс
 * резерв, а фон и research своих долей не превышают. Занять чужое
 * нечем — не потому что это запрещено правилом, а потому что такого
 * счётчика для них нет.
 *
 * Состояние живёт в Valkey и восстановимо (инвариант 2): потеря Valkey
 * означает, что все слоты свободны, а не что потеряны данные. Держатель
 * записан со сроком годности, поэтому упавший процесс освобождает слот
 * сам собой — просроченные держатели вычищаются при каждом захвате.
 */

import type { Redis } from "ioredis";

export type TurnClass = "interactive" | "background" | "research";

/**
 * Захват атомарен: вычистить просроченных, посчитать живых, добавить
 * себя — всё в одном скрипте. Иначе два процесса, посчитавшие
 * одновременно, оба увидели бы свободное место.
 */
const ACQUIRE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[5])
  return 1
end
return 0
`;

/** Продление — только для того, кто слот действительно держит. */
const RENEW_SCRIPT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0
`;

export interface TurnSlotBudget {
  /** Общий предел одновременных ходов. */
  total: number;
  interactive: number;
  background: number;
  research: number;
  /** Резерв, доступный только интерактивным ходам. */
  reserve: number;
}

/**
 * Раскладка `CLAUDE.md` для предела 128, пересчитанная пропорционально
 * под фактический предел. Резерв и research не опускаются ниже одного
 * слота, пока предел это позволяет: класс с нулём слотов — это не
 * «мало», а «выключен», и такое решение принимает человек, а не
 * округление.
 */
export function slotBudget(total: number): TurnSlotBudget {
  const limit = Math.max(4, Math.floor(total));
  const share = (part: number) => Math.max(1, Math.round((limit * part) / 128));
  const background = share(12);
  const research = share(8);
  const reserve = share(4);
  const interactive = Math.max(1, limit - background - research - reserve);
  return { total: limit, interactive, background, research, reserve };
}

export interface SlotHandle {
  turnClass: TurnClass;
  holder: string;
  release: () => Promise<void>;
  renew: () => Promise<boolean>;
}

export class TurnSemaphores {
  private readonly prefix: string;
  private readonly budget: TurnSlotBudget;
  private readonly leaseMs: number;

  constructor(
    private readonly redis: Redis,
    options: { total: number; leaseSeconds?: number; keyPrefix?: string },
  ) {
    this.budget = slotBudget(options.total);
    this.leaseMs = Math.max(5, options.leaseSeconds ?? 300) * 1_000;
    this.prefix = options.keyPrefix ?? "eva:slots:";
  }

  get limits(): TurnSlotBudget {
    return this.budget;
  }

  /** Сколько слотов у класса с учётом резерва, который есть только у интерактивных. */
  limitOf(turnClass: TurnClass): number {
    if (turnClass === "interactive") return this.budget.interactive + this.budget.reserve;
    if (turnClass === "background") return this.budget.background;
    return this.budget.research;
  }

  private key(turnClass: TurnClass): string {
    return `${this.prefix}${turnClass}`;
  }

  /**
   * Занять слот. `null` означает «сейчас мест нет» — это нормальный
   * ответ, а не ошибка: запись остаётся durable и дождётся своей
   * очереди.
   */
  async acquire(turnClass: TurnClass, holder: string): Promise<SlotHandle | null> {
    const now = Date.now();
    const expiresAt = now + this.leaseMs;
    const taken = await this.redis.eval(
      ACQUIRE_SCRIPT,
      1,
      this.key(turnClass),
      String(now),
      String(this.limitOf(turnClass)),
      holder,
      String(expiresAt),
      String(this.leaseMs * 4),
    );
    if (taken !== 1) return null;
    return {
      turnClass,
      holder,
      release: async () => {
        try {
          await this.redis.zrem(this.key(turnClass), holder);
        } catch {
          // Слот всё равно протухнет: срок годности записан в счёте.
        }
      },
      renew: async () => {
        try {
          const renewed = await this.redis.eval(
            RENEW_SCRIPT,
            1,
            this.key(turnClass),
            holder,
            String(Date.now() + this.leaseMs),
            String(this.leaseMs * 4),
          );
          return renewed === 1;
        } catch {
          return false;
        }
      },
    };
  }

  /** Занятые слоты по классам. Просроченные держатели не считаются. */
  async usage(): Promise<Record<TurnClass, { used: number; limit: number }>> {
    const now = Date.now();
    const classes: TurnClass[] = ["interactive", "background", "research"];
    const result = {} as Record<TurnClass, { used: number; limit: number }>;
    for (const turnClass of classes) {
      let used = 0;
      try {
        used = await this.redis.zcount(this.key(turnClass), now, "+inf");
      } catch {
        used = 0;
      }
      result[turnClass] = { used, limit: this.limitOf(turnClass) };
    }
    return result;
  }
}
