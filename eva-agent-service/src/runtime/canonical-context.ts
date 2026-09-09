/**
 * Канонические источники личности Евы: персона и системный промпт.
 *
 * До появления административной панели оба текста читались ровно из двух
 * файлов, смонтированных в контейнер read-only:
 *
 *   library/persona/eva.md          — персона (memory block `persona`);
 *   library/system/letta_local_memfs.md — raw system prompt агента.
 *
 * Файлы остаются значением по умолчанию и точкой отсчёта: они в Git, в
 * backup и в образе. Редактирование из панели не заводит второй копии
 * конфигурации — правка сохраняется версией в **уже существующем** реестре
 * артефактов (`artifacts`, миграция 039) под типом `prompt` и слагами
 * `eva-persona` и `eva-system-prompt`. Реестр умеет версии, утверждение,
 * публикацию и откат; своего механизма версий здесь нет.
 *
 * Порядок разрешения на чтении один и тот же везде:
 *
 *   действующая публикация артефакта в этом окружении → её текст;
 *   публикации нет                                    → текст файла.
 *
 * Это и означает совместимость: установка, где панель ничего не меняла,
 * ведёт себя ровно как раньше, а откат последней публикации возвращает
 * поведение к предыдущей версии — вплоть до файла.
 *
 * Чего здесь нет намеренно: применения к агентам. Реестр отвечает на
 * вопрос «какой текст канонический», а доставку этого текста живым агентам
 * выполняет `PersonaSync` — единственный существующий путь синхронизации
 * (инвариант 3: второго контура над Letta не заводим).
 */

import { ArtifactRegistry } from "../artifacts/registry.js";
import { badRequest } from "../errors.js";

/** Что именно правит администратор. Слаг артефакта выводится отсюда. */
export type CanonicalSource = "persona" | "system_prompt";

export const CANONICAL_SLUGS: Record<CanonicalSource, string> = {
  persona: "eva-persona",
  system_prompt: "eva-system-prompt",
};

/** Верхняя граница текста. Реестр — не файловое хранилище. */
const MAX_TEXT_BYTES = 200 * 1024;

export interface CanonicalDocument {
  source: CanonicalSource;
  /** Действующий текст: из публикации либо из файла. */
  text: string;
  /** `file` — правок не было; `registry` — действует опубликованная версия. */
  origin: "file" | "registry";
  /** Номер действующей версии реестра либо null, когда действует файл. */
  version: number | null;
  versionId: number | null;
  checksum: string | null;
  publishedAt: string | null;
  /** Есть ли куда откатываться одним действием. */
  rollbackAvailable: boolean;
  /** Путь файла-умолчания. Показывается оператору, не читается браузером. */
  defaultPath: string;
  /** Совпадает ли действующий текст с файлом. */
  matchesDefault: boolean;
  bytes: number;
}

export interface CanonicalContext {
  persona: string;
  systemPrompt: string;
}

export interface CanonicalHistoryEntry {
  version: number;
  versionId: number;
  checksum: string;
  publishedAt: string;
  retiredAt: string | null;
  reason: string;
  active: boolean;
}

interface Defaults {
  persona: string;
  systemPrompt: string;
  personaPath: string;
  systemPromptPath: string;
}

function textOf(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as { text?: unknown }).text;
  return typeof value === "string" ? value : null;
}

/**
 * Канонические тексты и их история.
 *
 * Один экземпляр на процесс. Кеша нет намеренно: тексты читаются на старте
 * и при каждом применении из панели, а не в каждом ходе, — держать ради
 * этого инвалидируемый кеш значило бы завести источник расхождения там,
 * где расхождение и есть главная опасность.
 */
export class CanonicalContextStore {
  constructor(
    private readonly registry: ArtifactRegistry,
    private readonly defaults: Defaults,
    private readonly environment: string,
  ) {}

  defaultText(source: CanonicalSource): string {
    return source === "persona" ? this.defaults.persona : this.defaults.systemPrompt;
  }

  defaultPath(source: CanonicalSource): string {
    return source === "persona" ? this.defaults.personaPath : this.defaults.systemPromptPath;
  }

  /** Действующие тексты обоих источников — то, с чем работает runtime. */
  async current(): Promise<CanonicalContext> {
    const [persona, systemPrompt] = await Promise.all([
      this.document("persona"),
      this.document("system_prompt"),
    ]);
    return { persona: persona.text, systemPrompt: systemPrompt.text };
  }

  /** Карточка одного источника: текст, происхождение, версия, откат. */
  async document(source: CanonicalSource): Promise<CanonicalDocument> {
    const fallback = this.defaultText(source);
    const artifact = await this.artifact(source);
    const publication = artifact
      ? await this.registry.active(artifact.id, this.environment)
      : null;

    let text = fallback;
    let checksum: string | null = null;
    if (publication) {
      const version = await this.registry.version(publication.versionId);
      const stored = textOf(version.body);
      // Версия без строки `text` невозможна: `validateArtifactBody`
      // отклоняет такую при создании. Но если она когда-нибудь появится
      // из восстановленного дампа, тихо работать с пустой персоной хуже,
      // чем вернуться к файлу.
      if (stored !== null) {
        text = stored;
        checksum = version.checksum;
      }
    }

    return {
      source,
      text,
      origin: checksum ? "registry" : "file",
      version: checksum ? publication!.version : null,
      versionId: checksum ? publication!.versionId : null,
      checksum,
      publishedAt: checksum ? publication!.publishedAt : null,
      rollbackAvailable: Boolean(publication && publication.previousVersionId !== null),
      defaultPath: this.defaultPath(source),
      matchesDefault: text.trim() === fallback.trim(),
      bytes: Buffer.byteLength(text, "utf8"),
    };
  }

  /** История публикаций источника, свежие сверху. */
  async history(source: CanonicalSource, limit = 20): Promise<CanonicalHistoryEntry[]> {
    const artifact = await this.artifact(source);
    if (!artifact) return [];
    const [publications, versions] = await Promise.all([
      this.registry.history(artifact.id, this.environment),
      this.registry.versions(artifact.id),
    ]);
    const byId = new Map(versions.map((version) => [version.id, version]));
    return publications.slice(0, limit).map((publication) => ({
      version: publication.version,
      versionId: publication.versionId,
      checksum: byId.get(publication.versionId)?.checksum ?? "",
      publishedAt: publication.publishedAt,
      retiredAt: publication.retiredAt,
      reason: publication.reason,
      active: publication.retiredAt === null,
    }));
  }

  /**
   * Сохранить новый текст и сделать его действующим.
   *
   * Одно действие, а не три: администратор нажимает «Сохранить», а версия,
   * утверждение и публикация — внутренняя механика реестра. Разносить их по
   * трём кнопкам панели значило бы предложить оператору состояние
   * «сохранено, но не применено», в котором система выглядит исправной и
   * работает по-старому.
   *
   * Возвращается карточка источника после применения: по ней видно, что
   * именно действует сейчас.
   */
  async save(input: {
    source: CanonicalSource;
    text: string;
    actorId?: string | null;
    reason?: string;
  }): Promise<CanonicalDocument> {
    const text = String(input.text ?? "");
    if (!text.trim()) throw badRequest("Текст пуст: сохранять нечего");
    const size = Buffer.byteLength(text, "utf8");
    if (size > MAX_TEXT_BYTES) {
      throw badRequest(`Текст ${size} байт при пределе ${MAX_TEXT_BYTES}`);
    }
    const current = await this.document(input.source);
    if (current.text.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")) {
      throw badRequest("Текст не изменился: новая версия не нужна");
    }

    const artifact = await this.requireArtifact(input.source);
    const created = await this.registry.createVersion({
      artifactId: artifact.id,
      body: { text },
      createdBy: input.actorId ?? null,
    });
    // Черновик → кандидат → утверждено: жизненный цикл реестра движется
    // только вперёд, и публикуется только утверждённая версия.
    await this.registry.setStatus(created.version.id, "candidate", input.actorId ?? null);
    await this.registry.setStatus(created.version.id, "approved", input.actorId ?? null);
    await this.registry.publish({
      artifactId: artifact.id,
      environment: this.environment,
      versionId: created.version.id,
      rolloutPercent: 100,
      reason: (input.reason ?? "").slice(0, 200),
      publishedBy: input.actorId ?? null,
    });
    return await this.document(input.source);
  }

  /** Вернуть предыдущую действующую версию. История не переписывается. */
  async rollback(input: {
    source: CanonicalSource;
    reason: string;
    actorId?: string | null;
  }): Promise<CanonicalDocument> {
    const artifact = await this.requireArtifact(input.source);
    await this.registry.rollback({
      artifactId: artifact.id,
      environment: this.environment,
      reason: String(input.reason ?? ""),
      publishedBy: input.actorId ?? null,
    });
    return await this.document(input.source);
  }

  /**
   * Вернуться к тексту файла.
   *
   * Отдельно от отката: откат идёт на одну публикацию назад, а этот путь
   * возвращает то, что лежит в репозитории, сколько бы правок ни было
   * между ними. Реализуется той же публикацией — версией с текстом файла,
   * — чтобы история осталась цельной, а не обрывалась «здесь кто-то
   * вернул всё как было».
   */
  async restoreDefault(input: {
    source: CanonicalSource;
    actorId?: string | null;
  }): Promise<CanonicalDocument> {
    return await this.save({
      source: input.source,
      text: this.defaultText(input.source),
      actorId: input.actorId,
      reason: `возврат к ${this.defaultPath(input.source)}`,
    });
  }

  private async artifact(source: CanonicalSource) {
    const slug = CANONICAL_SLUGS[source];
    const list = await this.registry.list("prompt");
    return list.find((item) => item.slug === slug && item.archivedAt === null) ?? null;
  }

  private async requireArtifact(source: CanonicalSource) {
    const artifact = await this.artifact(source);
    if (artifact) return artifact;
    // Артефакты заводит миграция 067. Их отсутствие означает установку без
    // накатанной миграции — молча создавать их здесь значило бы завести
    // запись в обход схемы, которую администратор потом не найдёт.
    throw badRequest(
      `Артефакт ${CANONICAL_SLUGS[source]} не найден: миграция 067 не накачена`,
    );
  }
}

export function canonicalSource(value: unknown): CanonicalSource {
  const text = String(value ?? "");
  if (text === "persona" || text === "system_prompt") return text;
  throw badRequest("Источник — persona или system_prompt");
}
