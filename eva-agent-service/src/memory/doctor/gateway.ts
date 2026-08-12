/**
 * Mini App поверх Memory Doctor.
 *
 * Владелец берётся из проверенной подписи Telegram и приводится к
 * внутреннему идентификатору здесь же — ровно как в контроле памяти.
 * Принимать `user_id` из тела запроса значило бы отдать чужой отчёт
 * тому, кто угадает число.
 *
 * Запуск отсюда только ставит задание: диагностика не выполняется в
 * запросе человека, иначе она попадала бы в путь ответа (требование 1
 * шага 17).
 */

import type { Database } from "../../db.js";
import type { JobEnvelopeInput } from "../../jobs/envelope.js";
import type {
  DoctorActionRow,
  DoctorReport,
  DoctorTrigger,
  MemoryDoctorService,
} from "./service.js";

export interface DoctorEnqueue {
  (userId: number, intent: JobEnvelopeInput): Promise<void>;
}

export class MiniAppDoctorGateway {
  constructor(
    private readonly db: Database,
    private readonly doctor: MemoryDoctorService,
    private readonly enqueue: DoctorEnqueue,
  ) {}

  /** Последний отчёт и открытые предложения к нему. */
  async report(telegramId: number): Promise<{
    report: DoctorReport | null;
    proposals: DoctorActionRow[];
  }> {
    const userId = await this.owner(telegramId);
    const report = await this.doctor.latestReport(userId);
    if (!report?.reportId) return { report, proposals: [] };
    return { report, proposals: await this.doctor.proposals(userId, report.reportId) };
  }

  /** Запросить диагностику. Возвращается ключ прогона, а не отчёт. */
  async request(telegramId: number, trigger: DoctorTrigger = "user"): Promise<{ reportKey: string }> {
    const userId = await this.owner(telegramId);
    const reportKey = crypto.randomUUID();
    await this.enqueue(userId, this.doctor.intent({
      userId, trigger, reportKey, traceId: crypto.randomUUID(),
    }));
    return { reportKey };
  }

  async preview(telegramId: number, actionId: number): ReturnType<MemoryDoctorService["preview"]> {
    return await this.doctor.preview(await this.owner(telegramId), actionId);
  }

  async apply(telegramId: number, actionId: number): Promise<{ ok: boolean; code?: string }> {
    const userId = await this.owner(telegramId);
    return await this.doctor.apply(userId, actionId, { type: "user", id: String(telegramId) });
  }

  async reject(telegramId: number, actionId: number): Promise<boolean> {
    return await this.doctor.reject(await this.owner(telegramId), actionId);
  }

  async rollback(telegramId: number, actionId: number): Promise<boolean> {
    return await this.doctor.rollback(await this.owner(telegramId), actionId);
  }

  private async owner(telegramId: number): Promise<number> {
    const { rows } = await this.db.withUserScope(
      { telegramId, label: "memory.doctor.owner", inherit: true },
      async () => await this.db.query<{ id: string }>(
        `SELECT id FROM users WHERE telegram_id = $1`,
        [telegramId],
      ),
    );
    if (!rows[0]) throw new Error("Пользователь не найден");
    const userId = Number(rows[0].id);
    this.db.bindScopeUserId(userId);
    return userId;
  }
}
