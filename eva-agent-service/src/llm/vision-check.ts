/**
 * Проверка распознавания изображений: настоящая картинка настоящим путём.
 *
 * Проба возможностей провайдера (`capability-probe.ts`) спрашивает модель
 * напрямую, минуя маршрутизацию, — и поэтому не заметила, как картинка
 * теряется по дороге: во внутреннем формате роутера её просто не было, а
 * разговор при этом продолжал работать. Эта проверка идёт ровно тем
 * путём, каким идёт фотография из Telegram: тот же URL роутера, тот же
 * указатель модели `eva/chat`, то же содержимое сообщения из текста и
 * изображения. Маршрут `vision` выбирает сам роутер по наличию картинки,
 * и несовпадение маршрута в ответе — уже отказ.
 *
 * Картинка залита одним цветом, а вопрос закрытый: модель, которая
 * изображение не получила, назвать цвет не может. Проверять описание
 * сложной сцены бессмысленно — совпадение слов пришлось бы оценивать той
 * же моделью.
 */

import { deflateSync } from "node:zlib";

/** Цвет заливки. Зелёный: модели, гадающие вслепую, называют синий и красный. */
const FILL = [0x2f, 0xa8, 0x4a] as const;
const FILL_WORDS = /(зел[ёе]н|green|verde|gr[uü]n|vert)/iu;
const SIDE = 128;

const QUESTION = "На изображении один сплошной цвет. Назови его одним словом, без пояснений.";

export interface VisionCheckResult {
  /** Ответ вообще получен. */
  ok: boolean;
  /** Цвет назван верно — картинка доехала до модели целой. */
  recognized: boolean;
  provider: string | null;
  model: string | null;
  /** Техническая цепочка, которой ушёл запрос. Обязана быть `vision`. */
  route: string | null;
  switches: number;
  latency_ms: number;
  /** Что ответила модель. Показывается человеку целиком. */
  answer: string;
  error: string | null;
}

export interface VisionCheckOptions {
  routerUrl: string;
  routerApiKey: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export async function runVisionCheck(options: VisionCheckOptions): Promise<VisionCheckResult> {
  const result: VisionCheckResult = {
    ok: false, recognized: false, provider: null, model: null, route: null,
    switches: 0, latency_ms: 0, answer: "", error: null,
  };
  if (!options.routerApiKey) {
    result.error = "EVA_ROUTER_API_KEY не задан — LLM Router недоступен";
    return result;
  }

  const image = `data:image/png;base64,${solidPng(SIDE, SIDE, FILL).toString("base64")}`;
  const started = Date.now();
  try {
    const response = await (options.fetcher ?? fetch)(
      `${options.routerUrl.replace(/\/+$/u, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.routerApiKey}`,
        },
        body: JSON.stringify({
          // Тот же указатель, что стоит у агента: маршрут `vision`
          // выбирает роутер, а не проверка. Назвать маршрут явно значило
          // бы проверить провайдера в обход того решения, которое и
          // ломалось.
          model: "eva/chat",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: QUESTION },
              { type: "image_url", image_url: { url: image } },
            ],
          }],
          max_tokens: 32,
          temperature: 0,
          metadata: { sensitive: false },
        }),
        signal: AbortSignal.timeout(Math.max(1_000, options.timeoutMs ?? 60_000)),
      },
    );
    result.latency_ms = Date.now() - started;
    const raw = await response.text();
    if (!response.ok) {
      result.error = `LLM Router вернул HTTP ${response.status}: ${raw.slice(0, 300)}`;
      return result;
    }
    const body = JSON.parse(raw) as {
      model?: string;
      choices?: Array<{ message?: { content?: unknown } }>;
      x_eva_router?: { provider?: string; switches?: number; route?: string };
    };
    result.provider = body.x_eva_router?.provider ?? null;
    result.route = body.x_eva_router?.route ?? null;
    result.switches = Number(body.x_eva_router?.switches ?? 0);
    result.model = body.model ?? null;
    result.answer = textOf(body.choices?.[0]?.message?.content).slice(0, 300);
    result.ok = result.answer.trim().length > 0;
    // Маршрут сверяется наравне с ответом: обычная модель на запрос с
    // картинкой отвечает охотно и убедительно, просто не про картинку.
    result.recognized = result.ok
      && result.route === "vision"
      && FILL_WORDS.test(result.answer);
    if (result.ok && result.route !== "vision") {
      result.error = `запрос ушёл маршрутом ${result.route ?? "неизвестно"}, а не vision`;
    }
    return result;
  } catch (error) {
    result.latency_ms = Date.now() - started;
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * PNG из одного цвета, собранный на месте.
 *
 * Готовая картинка в репозитории была бы файлом, про который никто не
 * помнит, чем он залит; здесь цвет и проверка ответа стоят рядом и
 * расходиться не могут. Формат минимальный: подпись, IHDR, IDAT, IEND.
 */
export function solidPng(width: number, height: number, rgb: readonly number[]): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // фильтр строки: без предсказания
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = rgb[0]!;
      raw[row + 2 + x * 3] = rgb[1]!;
      raw[row + 3 + x * 3] = rgb[2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // бит на канал
  ihdr[9] = 2;  // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
