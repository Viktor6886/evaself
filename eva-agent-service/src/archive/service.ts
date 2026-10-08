/**
 * Архив данных человека в Mini App: выгрузка в Excel и загрузка обратно
 * (docs/data-archive.md).
 *
 * Выгрузка уходит человеку в чат с ботом документом — тем же durable
 * outbox, что и остальные файлы. Ссылки на скачивание нет намеренно:
 * архив — это дневник, анкета и память, и ссылка, которую можно
 * переслать или найти в журнале прокси, хуже чата, где файл видит только
 * сам человек. Из чата файл сохраняется на телефон или компьютер обычным
 * образом.
 *
 * Загрузка идёт в два шага: предпросмотр (та же запись с откатом в конце)
 * и запись. Между шагами файл не хранится: человек присылает его снова, а
 * хэш из предпросмотра подтверждает, что записывается тот же файл.
 *
 * Обе операции выключены, пока владелец не включит флаг в панели. Память
 * Евы в архиве — отдельный флаг: это решение владельца (2026-10-07),
 * исключение из правила «содержимое memory blocks не раскрывается»,
 * зафиксированное в docs/INVARIANT_DIVERGENCES.md.
 */

import { createHash, randomUUID } from "node:crypto";

import type { Database } from "../db.js";
import { badRequest, EvaError, notFound } from "../errors.js";
import { isValidIanaTimezone } from "../time/local-date-time.js";
import { collectArchive, type MemorySnapshot } from "./export.js";
import { fold, wallClock } from "./format.js";
import { applyArchive, type ImportReport } from "./import-apply.js";
import { parseArchive } from "./import-parse.js";
import { ArchiveRejected } from "./import-types.js";
import { SHEETS } from "./sheets.js";
import { readWorkbook, WorkbookFormatError } from "./xlsx-reader.js";
import { writeWorkbook } from "./xlsx-writer.js";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Предел присланного файла — тот же, что у приёма файлов Mini App. */
export const ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;

export interface ArchiveFlags {
  enabled(): boolean;
  /** Включать ли в выгрузку лист «Память Евы». */
  memory(): boolean;
}

export interface ArchiveMemorySource {
  /** Блоки `human` и `current_state` агента человека; `null` — runtime их не отдал. */
  read(userId: number): Promise<{ human: string | null; current_state: string | null } | null>;
}

export interface ArchiveTelegram {
  sendDocument(
    chatId: number,
    document: Uint8Array,
    filename: string,
    options?: { caption?: string; mimeType?: string },
  ): Promise<void>;
}

type ArchiveDatabase = Pick<Database, "withUserScope" | "bindScopeUserId" | "query" | "transaction">;

export interface ImportOutcome extends ImportReport {
  /** Хэш файла: запись принимает только тот файл, что был в предпросмотре. */
  file_sha256: string;
  applied: boolean;
}

const FORMAT_ERRORS: Record<string, string> = {
  xlsx_not_zip: "Это не файл Excel (.xlsx). Загрузи архив, выгруженный из Евы.",
  xlsx_not_workbook: "Это не книга Excel (.xlsx). Загрузи архив, выгруженный из Евы.",
  xlsx_zip_malformed: "Файл повреждён — его не получается открыть как Excel.",
  xlsx_zip_bomb: "Файл слишком большой после распаковки — так архив Евы не выглядит.",
  xlsx_too_many_parts: "Файл устроен необычно для таблицы Excel — загрузка отклонена.",
  xlsx_part_name_invalid: "Файл повреждён или небезопасен — загрузка отклонена.",
  xlsx_doctype_forbidden: "Файл повреждён или небезопасен — загрузка отклонена.",
  xlsx_part_missing: "Файл повреждён — в нём не хватает частей.",
  xlsx_rows_unordered: "Файл повреждён: строки листа идут не по порядку.",
  xlsx_too_many_rows: "В листе слишком много строк. Раздели архив на несколько файлов.",
  xlsx_too_many_strings: "Файл слишком большой для архива Евы.",
};

const SHEET_NAMES = new Set(SHEETS.map((item) => fold(item.name)));

/** Откат предпросмотра: запись выполнена, но транзакция не фиксируется. */
class PreviewRollback extends Error {
  constructor(readonly report: ImportReport) {
    super("preview");
  }
}

export class DataArchiveService {
  private readonly now: () => Date;

  constructor(private readonly deps: {
    db: ArchiveDatabase;
    telegram: ArchiveTelegram;
    flags: ArchiveFlags;
    memory?: ArchiveMemorySource;
    /** После записи: сбросить кэш продуктового контекста человека. */
    onImported?: (userId: number) => void;
    now?: () => Date;
  }) {
    this.now = deps.now ?? (() => new Date());
  }

  enabled(): boolean {
    return this.deps.flags.enabled() === true;
  }

  overview(): { enabled: boolean; memory: boolean; max_bytes: number } {
    const enabled = this.enabled();
    return { enabled, memory: enabled && this.deps.flags.memory() === true, max_bytes: ARCHIVE_MAX_BYTES };
  }

  /** Собрать архив и отправить его человеку в чат с ботом. */
  async export(telegramId: number): Promise<{ sent: true; filename: string; sheets: number; rows: number; bytes: number }> {
    this.requireEnabled();
    return await this.scoped(telegramId, "miniapp.archive.export", async (user) => {
      const memory = await this.memory(user.id);
      const now = this.now();
      const collected = await this.deps.db.transaction(async (client) => {
        // Снимок на один момент: задача не попадёт в файл без своей цели.
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        return await collectArchive({ db: client, userId: user.id, zone: user.zone, now, memory });
      });
      const { bytes } = await writeWorkbook(collected.sheets, {
        title: "Архив данных Евы",
        creator: "Evaself",
        created: now,
      });
      const day = (wallClock(now, user.zone) ?? now.toISOString()).slice(0, 10);
      const filename = `eva-archive-${day}.xlsx`;
      const rows = Object.values(collected.counts).reduce((sum, value) => sum + (value ?? 0), 0);
      await this.deps.telegram.sendDocument(telegramId, bytes, filename, {
        mimeType: XLSX_MIME,
        caption: "Архив твоих данных из Евы. Сохрани файл на телефон или компьютер — "
          + "его можно загрузить обратно в разделе «Мои данные».",
      });
      await this.audit("archive.export", {
        sheets: collected.sheets.length,
        rows,
        bytes: bytes.length,
        memory: memory !== null,
        capped: collected.capped.length,
      });
      return { sent: true as const, filename, sheets: collected.sheets.length, rows, bytes: bytes.length };
    });
  }

  /** Показать, что добавится, ничего не записывая. */
  async preview(telegramId: number, file: Buffer): Promise<ImportOutcome> {
    return await this.importFile(telegramId, file, { apply: false });
  }

  /** Записать архив. `expectedSha256` — хэш из предпросмотра. */
  async apply(telegramId: number, file: Buffer, expectedSha256: string | null): Promise<ImportOutcome> {
    return await this.importFile(telegramId, file, { apply: true, expectedSha256 });
  }

  private async importFile(
    telegramId: number,
    file: Buffer,
    options: { apply: boolean; expectedSha256?: string | null },
  ): Promise<ImportOutcome> {
    this.requireEnabled();
    if (file.length === 0) throw badRequest("Файл пустой");
    if (file.length > ARCHIVE_MAX_BYTES) throw badRequest("Файл больше 10 МБ");
    const sha256 = createHash("sha256").update(file).digest("hex");
    if (options.apply && options.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new EvaError("Это другой файл, не тот, что был в предпросмотре. Выбери файл заново.", {
        code: "archive_file_changed",
        statusCode: 409,
      });
    }
    let book;
    try {
      book = await readWorkbook(file, { wanted: (name) => SHEET_NAMES.has(fold(name)) });
    } catch (error) {
      if (error instanceof WorkbookFormatError) throw badRequest(FORMAT_ERRORS[error.code] ?? "Файл не читается как Excel.");
      throw error;
    }
    return await this.scoped(telegramId, options.apply ? "miniapp.archive.import" : "miniapp.archive.preview", async (user) => {
      let parsed;
      try {
        parsed = parseArchive(book, { zone: user.zone });
      } catch (error) {
        if (error instanceof ArchiveRejected) throw badRequest(error.message);
        throw error;
      }
      if (parsed.sheetsFound.length === 0) {
        throw badRequest("В файле нет листов архива Евы. Загрузи файл, выгруженный в разделе «Мои данные».");
      }
      const now = this.now();
      let report: ImportReport;
      try {
        report = await this.deps.db.transaction(async (client) => {
          const result = await applyArchive(client, { userId: user.id, parsed, now });
          if (!options.apply) throw new PreviewRollback(result);
          return result;
        });
      } catch (error) {
        if (!(error instanceof PreviewRollback)) throw error;
        report = error.report;
      }
      if (options.apply) {
        this.deps.onImported?.(user.id);
        await this.audit("archive.import", {
          added: report.added_total,
          existing: report.existing_total,
          errors: report.error_count,
          paused_actions: report.paused_actions,
          sheets: report.sheets.map((item) => ({ id: item.id, added: item.added, existing: item.existing })),
        });
      }
      return { ...report, file_sha256: sha256, applied: options.apply };
    });
  }

  private requireEnabled(): void {
    if (!this.enabled()) throw badRequest("Архив данных отключён");
  }

  private async memory(userId: number): Promise<MemorySnapshot> {
    if (this.deps.flags.memory() !== true) return null;
    if (!this.deps.memory) return "unavailable";
    try {
      return (await this.deps.memory.read(userId)) ?? "unavailable";
    } catch {
      // Runtime недоступен — архив всё равно собирается, а лист честно
      // говорит, что памяти в нём нет.
      return "unavailable";
    }
  }

  private async scoped<T>(
    telegramId: number,
    label: string,
    work: (user: { id: number; zone: string }) => Promise<T>,
  ): Promise<T> {
    return await this.deps.db.withUserScope({ telegramId, label }, async () => {
      const { rows } = await this.deps.db.query<{ id: string; timezone: string | null }>(
        "SELECT id, timezone FROM users WHERE telegram_id = $1",
        [telegramId],
      );
      if (!rows[0]) throw notFound("Пользователь не найден: начни разговор с Евой в Telegram");
      const id = Number(rows[0].id);
      this.deps.db.bindScopeUserId(id);
      const zone = rows[0].timezone && isValidIanaTimezone(rows[0].timezone) ? rows[0].timezone : "UTC";
      return await work({ id, zone });
    });
  }

  /** Аудит без содержания: только числа и вид операции. */
  private async audit(operation: string, params: Record<string, unknown>): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO audit_log (actor, operation, target, params_redacted_json, result, request_id)
       VALUES ('eva-agent-service', $1, 'user_data_archive', $2::jsonb, 'success', $3)`,
      [operation, JSON.stringify(params), randomUUID()],
    );
  }
}

/**
 * Блоки памяти из состояния агента. Runtime отдаёт их либо в `blocks`,
 * либо в `memory.blocks`; нет ни того, ни другого — `null`, и выгрузка
 * пишет, что память недоступна, а не что она пуста.
 */
export function memoryBlocksOf(agent: unknown): { human: string | null; current_state: string | null } | null {
  if (!agent || typeof agent !== "object") return null;
  const state = agent as { blocks?: unknown; memory?: { blocks?: unknown } };
  const blocks = Array.isArray(state.blocks)
    ? state.blocks
    : Array.isArray(state.memory?.blocks) ? state.memory!.blocks as unknown[] : null;
  if (!blocks) return null;
  const value = (label: string): string | null => {
    const block = blocks.find((item) => item && typeof item === "object" && (item as { label?: unknown }).label === label);
    const text = block ? (block as { value?: unknown }).value : null;
    return typeof text === "string" && text.trim() ? text : null;
  };
  return { human: value("human"), current_state: value("current_state") };
}

/** Источник памяти поверх Letta: агент человека → его блоки. */
export function lettaMemorySource(
  db: Pick<Database, "agentIdOfUser">,
  letta: { getAgent(agentId: string): Promise<unknown> },
): ArchiveMemorySource {
  return {
    async read(userId: number) {
      const agentId = await db.agentIdOfUser(userId);
      if (!agentId) return { human: null, current_state: null };
      return memoryBlocksOf(await letta.getAgent(agentId));
    },
  };
}
