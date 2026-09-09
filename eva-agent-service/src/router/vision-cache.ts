/**
 * Описания изображений, полученные технической vision-моделью.
 *
 * Letta присылает роутеру всю историю диалога целиком, и картинка,
 * отправленная человеком однажды, приходит в каждом следующем ходе. Без
 * памяти о ней текстовая модель в режиме одной модели получала бы новое
 * описание той же картинки на каждый ход: лишний вызов vision-модели, её
 * оплата и — главное — каждый раз слегка другой текст описания. Со
 * стороны это выглядело так, будто Ева заново разглядывает старое фото и
 * возвращается к нему без повода.
 *
 * Кэш восстановимый и живёт в процессе: потеря означает одно лишнее
 * описание, а не потерю данных (инвариант 2). Отдельного хранилища для
 * него в репозитории не нашлось — ближайший аналог, приватная `Map` в
 * `RuntimeContextBuilder`, привязан к продуктовому контексту хода и не
 * переиспользуется (инвариант 20).
 */

import { createHash } from "node:crypto";

import type { LlmContentPart } from "./types.js";

export interface VisionCacheOptions {
  /** Сколько описаний держать. Картинок в одном диалоге единицы. */
  maxEntries?: number;
  /** Срок жизни описания. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class VisionDescriptionCache {
  private readonly entries = new Map<string, { description: string; expiresAt: number }>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: VisionCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  /**
   * Ключ — отпечаток самой картинки, а не её место в истории.
   *
   * Одно и то же фото в разных ходах и разных диалогах описывается один
   * раз; base64 в ключ не попадает, поэтому кэш не хранит содержимое
   * изображения (безопасность: PII не задерживается в памяти дольше
   * самого хода).
   */
  static keyFor(part: LlmContentPart): string | null {
    if (part.type === "image_url") {
      return createHash("sha256").update(part.url, "utf8").digest("hex");
    }
    if (part.type === "image") {
      return createHash("sha256")
        .update(part.media_type, "utf8")
        .update("\n", "utf8")
        .update(part.data, "utf8")
        .digest("hex");
    }
    return null;
  }

  get(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    // Перестановка в конец делает вытеснение по «давно не использованному»,
    // а не по «давно записанному»: картинка активного диалога не должна
    // выпадать из-за десятка чужих.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.description;
  }

  set(key: string, description: string): void {
    this.entries.delete(key);
    this.entries.set(key, { description, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}
