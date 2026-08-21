/**
 * Состояние развёртывания канонического контекста для health и `doctor`.
 *
 * Снимок в памяти процесса отвечает только на вопрос «что делал этот
 * процесс»: после рестарта он пуст, и установка, где половина агентов
 * осталась со старым текстом, показывала `never` — то есть выглядела
 * так же, как чистая. Каноническая же картина живёт в `agent_links`,
 * поэтому статус считается оттуда, а снимок остаётся телеметрией
 * последнего прохода.
 */

import { personaSyncState, type CanonicalSyncStatus, type PersonaSyncState } from "./persona-sync.js";

export interface CanonicalContextHealth {
  /** Состояние по базе: оно и решает, up-to-date установка или нет. */
  status: CanonicalSyncStatus;
  /** Отпечаток канонического набора репозитория прямо сейчас. */
  version: string;
  agents: {
    total: number;
    upToDate: number;
    stale: number;
    failed: number;
    deferred: number;
    unsupported: number;
    never: number;
  };
  lastSyncAt: string | null;
  /** Что делал этот процесс. Диагностика, а не источник истины. */
  process: PersonaSyncState;
}

interface CanonicalHealthSource {
  canonicalContextHealth(version: string): Promise<{
    version: string;
    total: number;
    upToDate: number;
    stale: number;
    failed: number;
    deferred: number;
    unsupported: number;
    never: number;
    lastSyncAt: string | null;
  }>;
}

/**
 * Свести отметки развёртывания в один статус.
 *
 * `stale` считается по несовпадению версии, а не по журналу попыток:
 * агент, до которого проход ещё не дошёл, ничем не отличается от того,
 * чья попытка сорвалась молча.
 */
export function canonicalStatusFrom(counts: {
  total: number;
  stale: number;
  failed: number;
  deferred: number;
  unsupported: number;
}): CanonicalSyncStatus {
  if (counts.total === 0) return "ok";
  if (counts.failed > 0) return counts.failed >= counts.total ? "failed" : "degraded";
  if (counts.stale > 0 || counts.deferred > 0) return "degraded";
  if (counts.unsupported > 0) return "unsupported";
  return "ok";
}

export async function canonicalContextHealth(
  db: CanonicalHealthSource,
  version: string,
): Promise<CanonicalContextHealth> {
  const process_ = personaSyncState();
  const counts = await db.canonicalContextHealth(version);
  return {
    status: canonicalStatusFrom(counts),
    version,
    agents: {
      total: counts.total,
      upToDate: counts.upToDate,
      stale: counts.stale,
      failed: counts.failed,
      deferred: counts.deferred,
      unsupported: counts.unsupported,
      never: counts.never,
    },
    lastSyncAt: counts.lastSyncAt,
    process: process_,
  };
}
