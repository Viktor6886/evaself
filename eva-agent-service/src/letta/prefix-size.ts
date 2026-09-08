/**
 * Из чего складывается постоянная часть каждого обращения к модели.
 *
 * Системный промпт, персона, блоки памяти и описания инструментов
 * уходят провайдеру в КАЖДОМ шаге КАЖДОГО хода, одинаковые до байта.
 * Сколько это стоит целиком, показывает `make check-tokens` — самое
 * дешёвое обращение за период и есть префикс. Но общее число не говорит,
 * ЧТО именно резать, а резать наугад — значит наугад же портить качество:
 * описание инструмента, которым Letta выбирает вызов, и рамка работы Евы
 * стоят одинаково в токенах и совсем по-разному в поведении.
 *
 * Здесь считаются знаки, а не токены. Знак — факт, токен зависит от
 * модели и от языка, и умножение на выдуманный коэффициент выдало бы за
 * измерение то, что измерением не является. Настоящий счёт в токенах
 * приходит от провайдера и лежит в `llm_requests.tokens_in`.
 *
 * Считается только ОБЩАЯ часть префикса: системный промпт, персона,
 * терапевтическая рамка и описания инструментов одинаковы для всех.
 * Блоки `human` и `current_state` принадлежат конкретному человеку,
 * меняются от агента к агенту и здесь не появляются — иначе это была бы
 * выборка по арендатору в маршруте, который к арендатору отношения не
 * имеет.
 */

/** Инструмент в том виде, в каком он уходит провайдеру. */
export interface PrefixTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface PrefixInput {
  systemPrompt: string;
  persona: string;
  /** Блоки памяти, общие для всех агентов, — со своими значениями. */
  sharedBlocks: ReadonlyArray<{ label: string; value: string }>;
  tools: readonly PrefixTool[];
}

export interface PrefixPart {
  part: string;
  chars: number;
  /** Доля от общей части префикса, проценты с одним знаком. */
  share_pct: number;
}

export interface PrefixReport {
  parts: PrefixPart[];
  total_chars: number;
  tools: {
    count: number;
    chars: number;
    /** Самые дорогие описания: с них начинается разговор о подрезке. */
    largest: Array<{ name: string; chars: number }>;
  };
}

/**
 * Во что обходится один инструмент.
 *
 * Схема сериализуется так же, как её отправляет адаптер, — иначе счёт
 * разошёлся бы с тем, что действительно уходит провайдеру.
 */
function toolChars(tool: PrefixTool): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }).length;
}

const TOP_TOOLS = 8;

export function prefixReport(input: PrefixInput): PrefixReport {
  const toolSizes = input.tools
    .map((tool) => ({ name: tool.name, chars: toolChars(tool) }))
    .sort((left, right) => right.chars - left.chars);
  const toolsChars = toolSizes.reduce((sum, item) => sum + item.chars, 0);

  const raw: Array<{ part: string; chars: number }> = [
    { part: "system_prompt", chars: input.systemPrompt.length },
    { part: "persona", chars: input.persona.length },
    ...input.sharedBlocks.map((block) => ({
      part: `block:${block.label}`,
      chars: block.value.length,
    })),
    { part: "tools", chars: toolsChars },
  ];

  const total = raw.reduce((sum, item) => sum + item.chars, 0);
  // Ноль знаков — законное состояние пустой установки, и делить на него
  // нельзя. Доли в этом случае честнее показать нулями, чем NaN.
  const share = (chars: number): number =>
    total === 0 ? 0 : Math.round((chars / total) * 1000) / 10;

  return {
    parts: raw
      .map((item) => ({ ...item, share_pct: share(item.chars) }))
      .sort((left, right) => right.chars - left.chars),
    total_chars: total,
    tools: {
      count: toolSizes.length,
      chars: toolsChars,
      largest: toolSizes.slice(0, TOP_TOOLS),
    },
  };
}
