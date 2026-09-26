/**
 * Счётчики OSINT для /metrics.
 *
 * Только события и их исходы: ни запросов, ни идентификаторов, ни
 * адресов профилей. Метки — закрытые наборы (вид события, сборщик,
 * статус), чтобы из метрики нельзя было восстановить, кого искали.
 */

const counters = new Map<string, number>();

export function recordOsint(kind: "investigation", outcome: "created" | "completed" | "cancelled" | "failed"): void;
export function recordOsint(kind: "run", collector: string, status: string): void;
export function recordOsint(kind: "requests", collector: string, amount: number): void;
export function recordOsint(kind: string, first: string, second?: string | number): void {
  const key = kind === "requests" ? `${kind}\u0000${first}` : `${kind}\u0000${first}\u0000${second ?? ""}`;
  const amount = kind === "requests" ? Math.max(0, Number(second) || 0) : 1;
  counters.set(key, (counters.get(key) ?? 0) + amount);
}

export function osintStats(): {
  investigations: Array<{ outcome: string; value: number }>;
  runs: Array<{ collector: string; status: string; value: number }>;
  requests: Array<{ collector: string; value: number }>;
} {
  const investigations: Array<{ outcome: string; value: number }> = [];
  const runs: Array<{ collector: string; status: string; value: number }> = [];
  const requests: Array<{ collector: string; value: number }> = [];
  for (const [key, value] of counters) {
    const [kind, first = "", second = ""] = key.split("\u0000");
    if (kind === "investigation") investigations.push({ outcome: first, value });
    else if (kind === "run") runs.push({ collector: first, status: second, value });
    else if (kind === "requests") requests.push({ collector: first, value });
  }
  return { investigations, runs, requests };
}
