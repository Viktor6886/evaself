/**
 * Safety net for messages that mention self-harm, harm to others or acute
 * danger.
 *
 * The persona already tells the model how to answer. This module is the part
 * that must not depend on a model deciding to cooperate: it records the event
 * in `crisis_events` so an operator can see it in the administrative panel,
 * and it pages the installation owner over Telegram.
 *
 * The event is metadata only — severity, which patterns fired, when, and
 * whose it is. The message itself is the most sensitive sentence a person
 * ever writes to Eva, and triage does not need it: the markers say what kind
 * of signal fired, and the person who must read the words is the person the
 * operator is about to talk to.
 *
 * The detector is deliberately conservative and deterministic. It is a
 * triage signal for a human, not a diagnosis, and it never blocks the reply —
 * a person in crisis must still get an answer.
 */

import type { Database } from "./db.js";
import type { Logger } from "./logger.js";
import type { TelegramClient } from "./telegram.js";

export type CrisisSeverity = "low" | "medium" | "high" | "critical";

export interface CrisisSignal {
  severity: CrisisSeverity;
  /** Pattern names that fired, for the operator — never the raw message. */
  markers: string[];
}

interface Rule {
  name: string;
  severity: CrisisSeverity;
  pattern: RegExp;
}

/**
 * `\b` is ASCII-only in JavaScript, so it never matches a boundary between
 * two Cyrillic letters — `/\bжить\b/` silently matches nothing useful. These
 * lookarounds are the Unicode-aware equivalent, and every pattern below is
 * compiled with the `u` flag so they work.
 */
const OPEN = "(?<![\\p{L}\\p{N}_])";
const CLOSE = "(?![\\p{L}\\p{N}_])";

/** Build a case-insensitive, Unicode-aware, whole-word-anchored pattern. */
function phrase(...alternatives: string[]): RegExp {
  return new RegExp(`${OPEN}(?:${alternatives.join("|")})${CLOSE}`, "iu");
}

/**
 * Patterns are matched against a lower-cased message. `critical` means an
 * expressed intention or plan; `high` a persistent wish; `medium` an
 * ambiguous but serious signal worth a human look.
 *
 * Everything here is intentionally narrow. A phrase like «убил весь день на
 * отчёт» must not page the owner at 3am, so the wording that only reads as
 * violent in idiom is excluded by requiring a reflexive or explicit object.
 */
/** Intent verbs that turn a bare mention into a stated plan. */
const INTENT = "хочу|хотела?|собира(?:юсь|лась|лся)|реши(?:л|ла)|планирую|намерен(?:а|ы)?|думаю";

const RULES: Rule[] = [
  {
    name: "suicide_intent",
    severity: "critical",
    pattern: phrase(
      "покончить\\s+(?:с\\s+)?соб(?:ой|ою)",
      "свести\\s+счёт{0,1}ы\\s+с\\s+жизнью",
      "свести\\s+счеты\\s+с\\s+жизнью",
      "уйти\\s+из\\s+жизни",
      `(?:${INTENT})\\s+(?:\\p{L}+\\s+){0,2}?(?:умереть|убить\\s+себя|сдохнуть)`,
      "kill\\s+myself",
      "commit\\s+suicide",
      "end\\s+(?:my\\s+life|it\\s+all)",
      "take\\s+my\\s+own\\s+life",
    ),
  },
  {
    name: "suicide_plan",
    severity: "critical",
    pattern: phrase(
      "предсмертн\\p{L}*\\s+(?:записк\\p{L}*|письм\\p{L}*)",
      "suicide\\s+note",
      "выпил\\p{L}*\\s+вс[её]\\s+таблетки",
      "(?:took|taken)\\s+(?:all\\s+)?(?:the\\s+)?pills",
    ),
  },
  {
    name: "harm_others",
    severity: "critical",
    pattern: phrase(
      // An explicit intent plus an explicit human object. No open-ended
      // object list, so "хочу убить время" stays out.
      `(?:${INTENT})\\s+(?:убить|зарезать|застрелить|покалечить)\\s+(?:его|её|ее|их|человека|людей|мать|отца|жену|мужа|соседа)`,
      "(?:i\\s+)?(?:want|plan|going)\\s+to\\s+(?:kill|shoot|hurt)\\s+(?:him|her|them|someone|people)",
    ),
  },
  {
    name: "self_harm",
    severity: "high",
    pattern: phrase(
      "(?:режу|резал(?:а|и)?|порезал(?:а|и)?|царапаю|жгу)\\s+себ(?:я|е)",
      "самоповрежд\\p{L}*",
      "причин(?:ить|яю)\\s+себе\\s+вред",
      "(?:cutting|cut|hurting|harming)\\s+myself",
      "self[-\\s]harm",
    ),
  },
  {
    name: "passive_ideation",
    severity: "high",
    pattern: phrase(
      "не\\s+хочу\\s+(?:больше\\s+)?жить",
      "незачем\\s+жить",
      "не\\s+вижу\\s+смысла\\s+жить",
      "лучше\\s+бы\\s+(?:я\\s+)?(?:не\\s+(?:родил\\p{L}*|существовал\\p{L}*)|умер|умерла)",
      "устал(?:а|и)?\\s+жить",
      "don'?t\\s+want\\s+to\\s+(?:live|be\\s+here)",
      "better\\s+off\\s+dead",
      "no\\s+reason\\s+to\\s+live",
    ),
  },
  {
    name: "acute_danger",
    severity: "medium",
    pattern: phrase(
      "меня\\s+(?:бьют|бь[ёе]т|избива\\p{L}+|душ(?:ит|ат))",
      "угрожа(?:ет|ют)\\s+убить",
      "мне\\s+угрожают",
      "(?:being|been)\\s+(?:beaten|abused)",
      "threatened\\s+to\\s+kill\\s+me",
    ),
  },
  {
    name: "hopelessness",
    severity: "medium",
    pattern: phrase(
      "вс[её]\\s+бессмысленно",
      "полная\\s+безысходность",
      "выхода\\s+нет",
      "мне\\s+не\\s+выкарабкаться",
      "hopeless",
      "there'?s\\s+no\\s+way\\s+out",
    ),
  },
];

const ORDER: Record<CrisisSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Pure classifier — exported so it can be tested without a database.
 * Returns null when nothing matched.
 */
export function detectCrisis(text: string): CrisisSignal | null {
  const haystack = (text ?? "").toLowerCase();
  if (!haystack.trim()) return null;

  const markers: string[] = [];
  let severity: CrisisSeverity | null = null;
  for (const rule of RULES) {
    if (!rule.pattern.test(haystack)) continue;
    markers.push(rule.name);
    if (severity === null || ORDER[rule.severity] > ORDER[severity]) {
      severity = rule.severity;
    }
  }
  return severity === null ? null : { severity, markers };
}

/**
 * Extra instruction appended to the turn when a signal fired, so the model
 * cannot drift past it even if the conversation is long and the persona has
 * been summarised out of the context window.
 */
export function safetyDirective(signal: CrisisSignal): string {
  const urgency =
    signal.severity === "critical" || signal.severity === "high"
      ? "Это приоритет выше любой другой задачи в сообщении."
      : "Отнесись к этому серьёзно, но без драматизации.";
  return [
    "[КОНТРОЛЬ БЕЗОПАСНОСТИ]",
    "В сообщении пользователя есть признаки риска для его жизни или здоровья.",
    urgency,
    "Оставайся спокойной и человечной. Не морализируй, не ставь диагноз и не",
    "прячься за длинным дисклеймером. Спроси о безопасности прямо сейчас и",
    "предложи связаться с близким человеком или местной экстренной службой,",
    "способной оказать физическую помощь. Не оставляй человека без ответа.",
  ].join("\n");
}

export class CrisisMonitor {
  constructor(
    private readonly db: Database,
    private readonly telegram: TelegramClient,
    private readonly logger: Logger,
    private readonly ownerTelegramId: number | null,
  ) {}

  /**
   * Classify one user message. Recording and paging must never break the
   * conversation, so every failure here is logged and swallowed — the caller
   * still gets the signal and still answers the person.
   */
  async inspect(input: {
    userId: number;
    telegramId: number;
    text: string;
    detectedBy?: string;
  }): Promise<CrisisSignal | null> {
    const signal = detectCrisis(input.text);
    if (!signal) return null;

    let eventId: string | null = null;
    try {
      // `trigger_text` намеренно не заполняется: сырое кризисное
      // сообщение не хранится вовсе. В событие идут только маркеры,
      // тяжесть и технические признаки — по ним видно, что сработало,
      // и не видно, что человек написал.
      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO crisis_events (user_id, severity, detected_by, meta)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id`,
        [
          input.userId,
          signal.severity,
          input.detectedBy ?? "eva-runtime",
          JSON.stringify({
            markers: signal.markers,
            telegram_id: input.telegramId,
            text_length: input.text.length,
          }),
        ],
      );
      eventId = rows[0]?.id ?? null;
    } catch (error) {
      this.logger.error("Не удалось записать crisis_event", {
        userId: input.userId,
        severity: signal.severity,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.warn("Обнаружен сигнал риска", {
      userId: input.userId,
      telegramId: input.telegramId,
      severity: signal.severity,
      markers: signal.markers,
      eventId,
    });

    await this.notifyOwner(input.telegramId, signal, eventId);
    return signal;
  }

  /**
   * The owner is paged for anything at or above `high`. Medium signals are
   * recorded for review but do not wake anybody up.
   */
  private async notifyOwner(
    telegramId: number,
    signal: CrisisSignal,
    eventId: string | null,
  ): Promise<void> {
    if (!this.ownerTelegramId) return;
    if (ORDER[signal.severity] < ORDER.high) return;
    if (this.ownerTelegramId === telegramId) return;

    // The message body itself is never forwarded, and it is not stored
    // either: the owner gets severity, markers and an event id, and talks
    // to the person if that is the right thing to do.
    const text = [
      `⚠️ Сигнал риска (${signal.severity}).`,
      `Пользователь: ${telegramId}`,
      eventId ? `crisis_events.id: ${eventId}` : "событие не записано в БД — проверьте логи",
      `Маркеры: ${signal.markers.join(", ")}`,
      "Текст сообщения не пересылается и не сохраняется: в событии только маркеры.",
    ].join("\n");

    try {
      // Кризисное сообщение идёт вперёд очереди: опоздав, оно теряет
      // смысл, а очередь доставки бывает длинной.
      // Владелец берётся в локальную переменную: внутри замыкания
      // сужение типа изменяемого поля класса не сохраняется.
      const owner = this.ownerTelegramId;
      await this.telegram.withPriority(
        "crisis",
        async () => await this.telegram.sendMessage(owner, text),
      );
    } catch (error) {
      this.logger.error("Не удалось уведомить владельца о сигнале риска", {
        severity: signal.severity,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
