import { randomUUID } from "node:crypto";

import type pg from "pg";

import { globalSecretRedactor } from "./redactor.js";

export interface AuditActor {
  id: string | null;
  username: string;
  role: string | null;
}

export interface AuditStart {
  requestId: string;
  operation: string;
  target: string | null;
  ip: string | null;
  actor: AuditActor;
  params: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly pool: pg.Pool) {}

  async start(input: AuditStart): Promise<{ id: string; startedAt: number }> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO audit_log
         (id, actor_user_id, actor, role, ip, operation, target,
          params_redacted_json, result, request_id)
       VALUES ($1, $2, $3, $4, $5::inet, $6, $7, $8::jsonb, 'pending', $9)`,
      [
        id,
        input.actor.id,
        globalSecretRedactor.redactText(input.actor.username).slice(0, 200),
        input.actor.role,
        input.ip,
        input.operation.slice(0, 200),
        input.target?.slice(0, 500) ?? null,
        JSON.stringify(globalSecretRedactor.redact(input.params)),
        input.requestId,
      ],
    );
    return { id, startedAt: Date.now() };
  }

  /**
   * Дописать подробности в уже открытую запись.
   *
   * Запись аудита открывается хуком до аутентификации и потому знает
   * только метод, маршрут и актора. Что именно было сделано — какая версия
   * артефакта опубликована, на что откатились — известно уже внутри
   * обработчика, и без этой дописи журнал отвечал бы «кто-то дёрнул
   * publish», не отвечая на вопрос «что теперь работает».
   *
   * Подробности проходят через тот же редактор секретов, что и параметры
   * запроса: в них не должно быть ни ключей, ни пользовательского текста.
   * Существующие поля не затираются, а дополняются.
   */
  async annotate(
    auditId: string,
    details: Record<string, unknown>,
    target?: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE audit_log
          SET params_redacted_json = params_redacted_json || $2::jsonb,
              target = COALESCE($3, target)
        WHERE id = $1`,
      [
        auditId,
        JSON.stringify(globalSecretRedactor.redact(details)),
        target?.slice(0, 500) ?? null,
      ],
    );
  }

  async finish(
    auditId: string,
    startedAt: number,
    result: "success" | "failure",
    message: string | null = null,
    actor?: AuditActor,
  ): Promise<void> {
    const safeMessage = message ? globalSecretRedactor.redactText(message).slice(0, 500) : null;
    await this.pool.query(
      `UPDATE audit_log
          SET completed_at = now(),
              duration_ms = $2,
              result = $3,
              message = $4,
              actor_user_id = COALESCE($5, actor_user_id),
              actor = CASE WHEN $6::text IS NULL THEN actor ELSE $6 END,
              role = COALESCE($7, role)
        WHERE id = $1 AND result = 'pending'`,
      [
        auditId,
        Math.max(0, Date.now() - startedAt),
        result,
        safeMessage,
        actor?.id ?? null,
        actor?.username ?? null,
        actor?.role ?? null,
      ],
    );
  }

  async list(limit: number): Promise<Array<Record<string, unknown>>> {
    const bounded = Math.min(Math.max(limit, 1), 500);
    const { rows } = await this.pool.query(
      `SELECT id, at, completed_at, actor, role, operation, target,
              params_redacted_json, result, request_id, duration_ms, message
         FROM audit_log
        ORDER BY at DESC, id DESC
        LIMIT $1`,
      [bounded],
    );
    return globalSecretRedactor.redact(rows);
  }
}
