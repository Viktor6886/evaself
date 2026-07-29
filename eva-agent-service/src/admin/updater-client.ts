import net from "node:net";
import { randomUUID } from "node:crypto";

import { AdminApiError } from "./errors.js";

export type UpdaterCommand =
  | "restart_service"
  | "get_service_status"
  | "get_service_logs"
  | "host_metrics"
  | "list_backups"
  | "create_backup"
  | "get_update_info"
  | "check_update"
  | "pull_and_up"
  | "handoff_update";

export interface UpdaterResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

export class UpdaterClient {
  constructor(
    private readonly socketPath =
      process.env.EVA_UPDATER_SOCKET ?? "/run/evaself-updater/updater.sock",
    private readonly timeoutMs = 35_000,
  ) {}

  async call<T>(
    command: UpdaterCommand,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const id = randomUUID();
    const response = await new Promise<UpdaterResponse<T>>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AdminApiError(
          "updater_timeout",
          "Сервис операций не ответил вовремя",
          504,
        ));
      }, timeoutMs);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, command, params })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(buffer.slice(0, newline)) as UpdaterResponse<T>);
        } catch {
          reject(new AdminApiError(
            "updater_invalid_response",
            "Сервис операций вернул некорректный ответ",
            502,
          ));
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
        reject(new AdminApiError(
          "updater_unavailable",
          "Сервис безопасного перезапуска недоступен",
          503,
        ));
      });
    });
    if (!response.ok) {
      throw new AdminApiError(
        response.error?.code ?? "updater_failed",
        response.error?.message ?? "Операция не выполнена",
        502,
      );
    }
    return response.result as T;
  }
}
