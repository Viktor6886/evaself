/** Minimal structured logger — one JSON object per line, no dependency. */

import { redactForLogs } from "./admin/redactor.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(level: string, service = "eva-agent-service"): Logger {
  const threshold = LEVELS[(level as Level)] ?? LEVELS.info;

  const emit = (lvl: Level, message: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < threshold) return;
    const line = redactForLogs({
      ts: new Date().toISOString(),
      level: lvl,
      service,
      message,
      ...(fields ?? {}),
    });
    const out = lvl === "error" || lvl === "warn" ? process.stderr : process.stdout;
    out.write(`${JSON.stringify(line)}\n`);
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
