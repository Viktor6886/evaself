import type { Config } from "./config.js";
import type { AgentLinkRow, Database, UserRow } from "./db.js";
import type { InboxResult } from "./delivery/inbox.js";
import { preferredResponseLanguage, t } from "./i18n/index.js";
import type { SupportedLanguage } from "./i18n/language-resolver.js";
import type { LettaService } from "./letta.js";
import type { LlmManager } from "./llm.js";
import type { Logger } from "./logger.js";
import type { UserQueue } from "./queue.js";
import type { RuntimeContextBuilder } from "./runtime/runtime-context.js";
import {
  type TelegramMessage,
  type TelegramUpdate,
  TelegramClient,
} from "./telegram.js";

interface NormalizedUpdate {
  updateId: number;
  message: TelegramMessage;
  telegramId: number;
  chatId: number;
  messageId: number;
  kind: "text" | "voice" | "image" | "document" | "unsupported";
  command: string | null;
}

export class EvaWorkflow {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly letta: LettaService,
    private readonly llm: LlmManager,
    private readonly queue: UserQueue,
    private readonly telegram: TelegramClient,
    private readonly runtimeContext: RuntimeContextBuilder,
    private readonly logger: Logger,
  ) {}

  /** Awaitable entry point used by tests and controlled reprocessing. */
  async handle(update: TelegramUpdate): Promise<void> {
    await this.processQueued(update);
  }

  /** The durable inbox is the only production caller of this method. */
  async processQueued(update: TelegramUpdate): Promise<InboxResult> {
    const normalized = normalizeUpdate(update);
    if (!normalized) return { status: "ignored" };
    return await this.telegram.withDeliveryContext(
      `telegram-update:${normalized.updateId}`,
      async () => await this.process(normalized),
    );
  }

  private async process(update: NormalizedUpdate): Promise<InboxResult> {
    const typing: { stop: (() => void) | null } = { stop: null };
    try {
      return await this.queue.run(update.telegramId, async () => {
        const { user, link } = await this.ensureUserAndAgent(update);
        const language = preferredResponseLanguage(user);
        await this.db.attachTelegramUpdateToUser(update.updateId, user.id);

        if (user.is_blocked || user.state === "blocked") {
          await this.telegram.sendMessage(update.chatId, t(language, "accessBlocked"));
          return { status: "ignored" };
        }

        if (update.command) {
          await this.handleCommand(update, user, language);
          return { status: "completed" };
        }

        if (update.kind === "unsupported") {
          await this.telegram.sendMessage(
            update.chatId,
            t(language, "unsupportedMessage"),
          );
          return { status: "ignored" };
        }

        const quota = await this.db.getQuotaStatus(update.telegramId);
        const messageQuota = quota.find((item) => item.metric === "messages") as
          | { remaining?: number | string | null; limit_value?: number | string }
          | undefined;
        if (
          messageQuota?.remaining !== null &&
          messageQuota?.remaining !== undefined &&
          Number(messageQuota.remaining) <= 0
        ) {
          await this.telegram.sendMessage(
            update.chatId,
            t(language, "messageQuotaEnded"),
          );
          return { status: "ignored" };
        }
        if (update.kind === "voice") {
          const voiceQuota = quota.find((item) => item.metric === "voice_minutes") as
            | { remaining?: number | string | null }
            | undefined;
          if (
            voiceQuota?.remaining !== null &&
            voiceQuota?.remaining !== undefined &&
            Number(voiceQuota.remaining) <= 0
          ) {
            await this.telegram.sendMessage(
              update.chatId,
              t(language, "voiceQuotaEnded"),
            );
            return { status: "ignored" };
          }
        }

        const prompt = await this.promptFromMessage(update, language);
        typing.stop = this.telegram.startTyping(update.chatId, this.config.typingIntervalMs);
        await this.db.recordUserMessage(user.id);
        const conversationId = link.conversation_id;
        if (!conversationId) throw new Error("У агента отсутствует активный conversation");

        const context = await this.runtimeContext.build({
          userId: user.id,
          conversationId,
          userMessage: prompt,
          languageMessage:
            update.message.text?.trim() ||
            update.message.caption?.trim() ||
            (update.kind === "voice" ? prompt : ""),
        });
        const answer = await this.letta.runTurn(
          conversationId,
          this.runtimeContext.wrapUserMessage(context, prompt),
        );
        await this.db.markAgentUsed(link.agent_id);
        const turn = answer;

        const reply = turn.reply.trim() || t(language, "emptyReply");
        const responseMode = context.responseMode;
        if (responseMode === "text" || responseMode === "both") {
          await this.telegram.sendMessage(update.chatId, reply);
        }
        if (responseMode === "voice" || responseMode === "both") {
          try {
            await this.sendVoice(update.chatId, reply, context.userId);
          } catch (error) {
            this.logger.warn("Голосовой ответ недоступен, отправлен текст", {
              updateId: update.updateId,
              message: error instanceof Error ? error.message : String(error),
            });
            if (responseMode === "voice") await this.telegram.sendMessage(update.chatId, reply);
          }
        }

        await this.db.incrementUsage(update.telegramId, "messages");
        return { status: "completed", usageCharged: true };
      });
    } finally {
      typing.stop?.();
    }
  }

  private async ensureUserAndAgent(
    update: NormalizedUpdate,
  ): Promise<{ user: UserRow; link: AgentLinkRow }> {
    const from = update.message.from!;
    const user = await this.db.upsertUser({
      telegramId: update.telegramId,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      languageCode: from.language_code ?? null,
    });
    let link = await this.db.getAgentLink(update.telegramId);
    if (!link) {
      let agentId = await this.letta.findAgentByTelegramId(update.telegramId);
      if (!agentId) {
        const displayName =
          [from.first_name, from.last_name].filter(Boolean).join(" ") ||
          from.username ||
          String(from.id);
        agentId = await this.letta.createAgent({
          telegramId: update.telegramId,
          displayName,
        });
      }
      const conversationId = await this.letta.createConversation(agentId);
      link = await this.db.saveAgentLink({
        userId: user.id,
        agentId,
        conversationId,
        agentName: `eva-${update.telegramId}`,
        model: this.config.model || null,
      });
      await this.db.setUserState(user.id, "active");
      return { user: { ...user, state: "active" }, link };
    }
    if (!link.conversation_id) {
      const conversationId = await this.letta.createConversation(link.agent_id);
      await this.db.setConversation(link.agent_id, conversationId);
      link = { ...link, conversation_id: conversationId };
    }
    return { user, link };
  }

  private async handleCommand(
    update: NormalizedUpdate,
    user: UserRow,
    language: SupportedLanguage,
  ): Promise<void> {
    switch (update.command) {
      case "/start":
        await this.db.setUserState(user.id, "active");
        await this.telegram.sendProgressiveMessage(
          update.chatId,
          t(language, "start"),
        );
        break;
      case "/help":
        await this.telegram.sendMessage(
          update.chatId,
          t(language, "help"),
        );
        break;
      case "/balance": {
        const quotas = await this.db.getQuotaStatus(update.telegramId);
        const lines = quotas.map((item) => {
          const row = item as Record<string, unknown>;
          const remaining = row.remaining === null
            ? t(language, "unlimited")
            : t(language, "remaining", { value: String(row.remaining) });
          return `${quotaLabel(String(row.metric), language)}: ${remaining}`;
        });
        await this.telegram.sendMessage(
          update.chatId,
          lines.length
            ? `${t(language, "limitsTitle")}\n${lines.join("\n")}`
            : t(language, "limitsMissing"),
        );
        break;
      }
      case "/subscription": {
        const buttons = Object.entries(this.config.lavaPlans)
          .filter(([, plan]) => plan.paymentUrl)
          .map(([, plan]) => [{
            text: `${plan.plan} — ${(plan.amountMinor / 100).toFixed(0)} ${plan.currency}`,
            url: plan.paymentUrl,
          }]);
        await this.telegram.sendMessage(
          update.chatId,
          buttons.length
            ? t(language, "chooseSubscription")
            : t(language, "subscriptionUnavailable"),
          buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {},
        );
        break;
      }
      case "/privacy":
        await this.telegram.sendMessage(
          update.chatId,
          t(language, "privacy"),
        );
        break;
      default:
        await this.telegram.sendMessage(update.chatId, t(language, "unknownCommand"));
    }
  }

  private async promptFromMessage(
    update: NormalizedUpdate,
    language: SupportedLanguage,
  ): Promise<string> {
    const message = update.message;
    if (update.kind === "text") return message.text?.trim() || message.caption?.trim() || "";
    if (update.kind === "voice") {
      const file = message.voice ?? message.audio;
      if (!file) throw new Error("Голосовой файл отсутствует");
      const response = await fetch(`${this.config.mediaServiceUrl.replace(/\/+$/, "")}/telegram/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          file_id: file.file_id,
          language: message.from?.language_code ?? "ru",
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
      const body = await response.json() as {
        text?: string;
        duration_minutes?: number;
        error?: { message?: string };
      };
      if (!response.ok || !body.text?.trim()) {
        throw new Error(body.error?.message ?? `ASR вернул HTTP ${response.status}`);
      }
      if (body.duration_minutes) {
        await this.db.incrementUsage(
          update.telegramId,
          "voice_minutes",
          Math.max(1, Math.ceil(body.duration_minutes)),
        );
      }
      await this.telegram.sendMessage(
        update.chatId,
        t(language, "transcript", { text: body.text.trim() }),
      );
      return body.text.trim();
    }
    if (update.kind === "image") {
      const photo = message.photo?.at(-1);
      if (!photo) throw new Error("Изображение отсутствует");
      const downloaded = await this.telegram.downloadFile(photo.file_id);
      const mime = downloaded.path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      const caption = message.caption?.trim();
      const description = await this.llm.complete([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Подробно и без домыслов опиши изображение для личного AI-агента Евы. Извлеки весь видимый текст. Вопрос пользователя: ${caption || "(нет вопроса)"}`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mime};base64,${Buffer.from(downloaded.bytes).toString("base64")}`,
              },
            },
          ],
        },
      ]);
      return `[ИЗОБРАЖЕНИЕ ПОЛЬЗОВАТЕЛЯ]\n${description}\n\nКомментарий: ${caption || "нет"}`;
    }
    if (update.kind === "document") {
      const document = message.document;
      if (!document) throw new Error("Документ отсутствует");
      if ((document.file_size ?? 0) > 2 * 1024 * 1024) {
        throw new Error("Документ больше 2 МБ; отправьте текст или более короткий файл");
      }
      const downloaded = await this.telegram.downloadFile(document.file_id);
      const filename = document.file_name ?? downloaded.path;
      const isText = /\.(txt|md|json|csv|log|yaml|yml)$/i.test(filename) ||
        document.mime_type?.startsWith("text/");
      if (!isText) {
        throw new Error("Пока поддерживаются текстовые документы: txt, md, json, csv, yaml");
      }
      const contents = new TextDecoder("utf-8", { fatal: false }).decode(downloaded.bytes);
      return `[ДОКУМЕНТ ${filename}]\n${contents.slice(0, 100_000)}\n\nКомментарий: ${message.caption ?? "нет"}`;
    }
    throw new Error("Неподдерживаемый тип сообщения");
  }

  private async sendVoice(chatId: number, text: string, userId?: number): Promise<void> {
    const response = await fetch(`${this.config.mediaServiceUrl.replace(/\/+$/, "")}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text.slice(0, 8_000), format: "voice" }),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`TTS вернул HTTP ${response.status}: ${message.slice(0, 500)}`);
    }
    await this.telegram.sendVoice(chatId, new Uint8Array(await response.arrayBuffer()));
    if (userId) {
      await this.db.query(
        "UPDATE user_preferences SET updated_at = now() WHERE user_id = $1",
        [userId],
      );
    }
  }
}

export function normalizeUpdate(update: TelegramUpdate): NormalizedUpdate | null {
  const message = update.message ?? update.edited_message;
  const from = message?.from;
  if (!message || !from || from.is_bot) return null;
  const commandMatch = message.text?.trim().match(/^\/([a-z_]+)(?:@\w+)?(?:\s|$)/i);
  const command = commandMatch?.[1] ? `/${commandMatch[1].toLowerCase()}` : null;
  const kind = message.voice || message.audio
    ? "voice"
    : message.photo?.length
      ? "image"
      : message.document
        ? "document"
        : message.text || message.caption
          ? "text"
          : "unsupported";
  return {
    updateId: update.update_id,
    message,
    telegramId: from.id,
    chatId: message.chat.id,
    messageId: message.message_id,
    kind,
    command,
  };
}

function quotaLabel(metric: string, language: SupportedLanguage): string {
  return (language === "en"
    ? {
        messages: "Messages",
        voice_minutes: "Voice minutes",
        web_search: "Search",
        tests: "Tests",
      }
    : {
        messages: "Сообщения",
        voice_minutes: "Голосовые минуты",
        web_search: "Поиск",
        tests: "Тесты",
      })[metric] ?? metric;
}
