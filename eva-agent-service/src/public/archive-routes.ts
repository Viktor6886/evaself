/**
 * Архив данных в Mini App (docs/data-archive.md): выгрузка всех своих
 * данных в Excel и загрузка такого файла обратно — только дополнением.
 *
 * Человек определяется подписью Mini App, а не телом запроса. Функция
 * выключена флагом — `GET /archive` отвечает `enabled: false`, и по нему
 * Mini App прячет раздел, а не показывает кнопку, которая отказывает.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import { badRequest } from "../errors.js";

/** Операции по telegram id; сопоставление с внутренним пользователем — у сервиса. */
export interface DataArchivePublic {
  overview(): { enabled: boolean; memory: boolean; max_bytes: number };
  export(telegramId: number): Promise<unknown>;
  preview(telegramId: number, file: Buffer): Promise<unknown>;
  apply(telegramId: number, file: Buffer, expectedSha256: string): Promise<unknown>;
}

/** Лимит по человеку поверх общего: сборка архива — дорогая операция. */
export type ArchiveRateLimit = (bucket: string, limit: number, windowSeconds: number) => Promise<void>;

const FILE_LIMIT = 10 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

async function uploadedFile(request: FastifyRequest): Promise<Buffer> {
  let part;
  try {
    part = await request.file({ limits: { files: 1, fields: 0, parts: 1, fileSize: FILE_LIMIT } });
  } catch {
    throw badRequest("Некорректная загрузка файла");
  }
  if (!part || part.fieldname !== "file") throw badRequest("Ожидается файл в поле file");
  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch {
    throw badRequest("Файл больше 10 МБ");
  }
  if (part.file.truncated) throw badRequest("Файл больше 10 МБ");
  return bytes;
}

export function registerArchivePublicRoutes(
  publicApp: FastifyInstance,
  archive: DataArchivePublic | undefined,
  telegramIdOf: (request: unknown) => number,
  rateLimit: ArchiveRateLimit,
): void {
  const service = (): DataArchivePublic => {
    if (!archive || !archive.overview().enabled) throw badRequest("Архив данных отключён");
    return archive;
  };
  publicApp.get("/archive", async () => archive?.overview() ?? { enabled: false, memory: false, max_bytes: FILE_LIMIT });

  publicApp.post("/archive/export", async (request) => {
    const archiveService = service();
    const telegramId = telegramIdOf(request);
    await rateLimit(`public:archive:export:${telegramId}`, 3, 600);
    return await archiveService.export(telegramId);
  });

  publicApp.post("/archive/import/preview", { bodyLimit: FILE_LIMIT + 64 * 1024 }, async (request) => {
    const archiveService = service();
    const telegramId = telegramIdOf(request);
    await rateLimit(`public:archive:preview:${telegramId}`, 20, 600);
    return await archiveService.preview(telegramId, await uploadedFile(request));
  });

  publicApp.post("/archive/import", { bodyLimit: FILE_LIMIT + 64 * 1024 }, async (request) => {
    const archiveService = service();
    const telegramId = telegramIdOf(request);
    // Запись — только второй шаг после предпросмотра: отметка того файла,
    // который человек видел, обязательна.
    const expected = (request.query as { sha256?: unknown } | undefined)?.sha256;
    if (typeof expected !== "string" || !SHA256.test(expected)) {
      throw badRequest("Сначала посмотри, что добавится: загрузи файл ещё раз");
    }
    await rateLimit(`public:archive:import:${telegramId}`, 5, 600);
    return await archiveService.apply(telegramId, await uploadedFile(request), expected);
  });
}
