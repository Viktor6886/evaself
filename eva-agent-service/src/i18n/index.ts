import {
  normalizeSupportedLanguage,
  type SupportedLanguage,
} from "./language-resolver.js";

const ru = {
  accessBlocked: "Доступ к Еве временно ограничен.",
  unsupportedMessage:
    "Сейчас я понимаю текст, голосовые сообщения, изображения и небольшие документы.",
  messageQuotaEnded:
    "Лимит сообщений на текущий период закончился. Проверить его можно командой /balance.",
  voiceQuotaEnded:
    "Лимит распознавания голоса закончился. Можно продолжить текстом.",
  emptyReply: "Я рядом. Попробуй сформулировать это немного иначе.",
  start:
    "Привет! Я Ева — собеседник и помощник в самопознании. Я запоминаю важный контекст на твоём сервере. Напиши, что сейчас занимает твои мысли.",
  startFirst:
    "Привет! Я Ева — собеседник и помощник в самопознании. Давай знакомиться без длинной анкеты: как мне лучше к тебе обращаться? Этот вопрос можно пропустить.",
  help:
    "Можно писать текстом или отправлять голосовые сообщения и изображения.\n\n/balance — текущие лимиты\n/subscription — варианты доступа\n/privacy — как хранятся данные",
  limitsTitle: "Текущие лимиты:",
  limitsMissing: "Лимиты пока не настроены.",
  remaining: "осталось {value}",
  unlimited: "без ограничений",
  chooseSubscription: "Выбери подходящий вариант доступа:",
  subscriptionUnavailable: "Онлайн-оплата ещё не настроена администратором.",
  privacy:
    "Связь с агентом, заметки и задачи хранятся в PostgreSQL и Letta на сервере владельца Evaself. API-ключи зашифрованы и не выдаются в WebUI. Администратор может удалить агента и его данные.",
  unknownCommand: "Неизвестная команда. Список: /help",
  transcript: "Распознала: {text}",
} as const;

const en: Record<keyof typeof ru, string> = {
  accessBlocked: "Access to Eva is temporarily restricted.",
  unsupportedMessage:
    "I currently understand text, voice messages, images, and small documents.",
  messageQuotaEnded:
    "Your message allowance for this period is used up. Check it with /balance.",
  voiceQuotaEnded:
    "Your voice transcription allowance is used up. You can continue with text.",
  emptyReply: "I’m here. Try phrasing that a little differently.",
  start:
    "Hi! I’m Eva, a companion and self-discovery assistant. I keep important context on your server. Tell me what is on your mind right now.",
  startFirst:
    "Hi! I’m Eva, a companion and self-discovery assistant. Let’s get acquainted without a long form: what should I call you? You can skip this question.",
  help:
    "You can send text, voice messages, or images.\n\n/balance — current limits\n/subscription — access options\n/privacy — how data is stored",
  limitsTitle: "Current limits:",
  limitsMissing: "Limits have not been configured yet.",
  remaining: "{value} remaining",
  unlimited: "unlimited",
  chooseSubscription: "Choose an access option:",
  subscriptionUnavailable: "Online payments have not been configured by the administrator yet.",
  privacy:
    "Your agent link, notes, and tasks are stored in PostgreSQL and Letta on the Evaself owner’s server. API keys are encrypted and never returned to WebUI. An administrator can delete the agent and its data.",
  unknownCommand: "Unknown command. See /help",
  transcript: "Transcribed: {text}",
};

export type MessageKey = keyof typeof ru;

export function t(
  language: SupportedLanguage,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  let message: string = (language === "en" ? en : ru)[key];
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

export function preferredResponseLanguage(user: {
  language_mode?: string;
  preferred_language?: string | null;
  last_message_language?: string | null;
  language_code?: string | null;
}): SupportedLanguage {
  return (
    (user.language_mode === "fixed"
      ? normalizeSupportedLanguage(user.preferred_language)
      : null) ??
    normalizeSupportedLanguage(user.last_message_language) ??
    normalizeSupportedLanguage(user.language_code) ??
    "ru"
  );
}
