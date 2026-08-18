/**
 * Чтение страницы через локальный Crawl4AI.
 *
 * `web_search` находит адреса, но прочитать их было нечем: продуктового
 * инструмента чтения у Евы не было вовсе, и путь «поиск → страница →
 * ответ» обрывался на первом шаге. Модель в этом месте либо отвечала по
 * заголовкам выдачи, либо выдумывала содержимое.
 *
 * Три вещи, без которых этот инструмент опасен:
 *
 *  1. Адрес приходит из интернета, поэтому проверяется как чужой:
 *     частные и служебные адреса недоступны, перенаправления
 *     перепроверяются (`OutboundGateway`).
 *  2. Crawl4AI закрыт токеном. Без заголовка `Authorization` он отвечает
 *     отказом, и раньше именно так и отвечал.
 *  3. Прочитанное — данные, а не инструкции: содержимое проходит через
 *     `sanitizeUntrustedContent` и приходит модели в конверте
 *     `UNTRUSTED_CONTENT`.
 */

import { OutboundGateway } from "../admin/outbound-gateway.js";
import { sanitizeUntrustedContent } from "../knowledge/security.js";

export interface WebPage {
  url: string;
  title: string;
  /** Текст страницы в конверте недоверенного содержимого. */
  content: string;
  /** Текст обрезан по лимиту: страница длиннее, чем помещается в ход. */
  truncated: boolean;
  language: string | null;
}

export interface Crawl4aiOptions {
  baseUrl: string;
  token: string;
  /** Потолок ответа Crawl4AI. */
  maxBytes?: number;
  /** Потолок текста, который уходит модели. */
  maxCharacters?: number;
  timeoutMs?: number;
  /** Шлюз к самому Crawl4AI: внутренний адрес, поэтому со своим списком. */
  gateway?: Pick<OutboundGateway, "request">;
  /** Шлюз проверки чужого адреса: без списка, с полной защитой от SSRF. */
  guard?: Pick<OutboundGateway, "validate">;
}

interface Crawl4aiResult {
  url?: string;
  success?: boolean;
  status_code?: number;
  error_message?: string;
  markdown?: string | { raw_markdown?: string; fit_markdown?: string };
  cleaned_html?: string;
  html?: string;
  metadata?: { title?: string; language?: string };
}

/** Отказ чтения с кодом: вызывающий отличает «эту не смог» от «всё сломано». */
export class WebReadError extends Error {
  constructor(readonly code: string, message: string, readonly status: number | null = null) {
    super(message);
    this.name = "WebReadError";
  }
}

export class Crawl4aiReader {
  private readonly maxBytes: number;
  private readonly maxCharacters: number;
  private readonly gateway: Pick<OutboundGateway, "request">;
  private readonly guard: Pick<OutboundGateway, "validate">;

  constructor(private readonly options: Crawl4aiOptions) {
    this.maxBytes = Math.max(64 * 1024, options.maxBytes ?? 2 * 1024 * 1024);
    this.maxCharacters = Math.max(1_000, options.maxCharacters ?? 12_000);
    const host = hostOf(options.baseUrl);
    this.gateway = options.gateway ?? new OutboundGateway({
      // Сам Crawl4AI стоит во внутренней сети: без явного разрешения
      // защита от SSRF отвергла бы обращение к нему самому.
      allowlist: host ? [host] : [],
      maxBodyBytes: this.maxBytes,
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    this.guard = options.guard ?? new OutboundGateway({ allowlist: [] });
  }

  async read(rawUrl: string, signal?: AbortSignal): Promise<WebPage> {
    // Проверяется адрес страницы, а не адрес Crawl4AI: именно он пришёл
    // из интернета и именно им можно попросить сходить внутрь сети.
    const target = await this.guard.validate(rawUrl).catch(() => {
      throw new WebReadError("web_read_blocked", "Адрес недоступен для чтения");
    });

    const headers: Record<string, string> = { "content-type": "application/json" };
    // Пустой токен заголовка не создаёт: Crawl4AI без токена настроен
    // открыто, и `Bearer ` без значения он отвергает.
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;

    const response = await this.gateway.request(
      new URL("crawl", withSlash(this.options.baseUrl)).toString(),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ urls: [target.toString()] }),
        signal,
      },
    );
    if (!response.ok) {
      throw new WebReadError(
        response.status === 401 || response.status === 403
          ? "web_read_unauthorized"
          : "web_read_failed",
        `Crawl4AI вернул HTTP ${response.status}`,
        response.status,
      );
    }

    const payload = response.json<{ results?: Crawl4aiResult[]; error?: string }>();
    const item = payload.results?.[0];
    if (!item) throw new WebReadError("web_read_empty", "Crawl4AI не вернул страницу");
    if (item.success === false) {
      throw new WebReadError(
        "web_read_page_failed",
        `Страница не прочитана: HTTP ${item.status_code ?? "?"}`,
        item.status_code ?? null,
      );
    }
    const raw = textOf(item);
    if (!raw) throw new WebReadError("web_read_empty", "Страница не содержит текста");

    const limited = raw.slice(0, this.maxCharacters);
    return {
      url: item.url ?? target.toString(),
      title: item.metadata?.title?.slice(0, 300) ?? target.hostname,
      // Содержимое страницы — данные. Скрытые инструкции нейтрализуются
      // здесь же, а не «когда-нибудь у вызывающего».
      content: sanitizeUntrustedContent(limited),
      truncated: raw.length > limited.length,
      language: item.metadata?.language ?? null,
    };
  }
}

function textOf(item: Crawl4aiResult): string {
  const markdown = typeof item.markdown === "string"
    ? item.markdown
    : item.markdown?.fit_markdown || item.markdown?.raw_markdown;
  return (markdown || item.cleaned_html || item.html || "").trim();
}

function withSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}
