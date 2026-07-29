import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { UserProfileService } from "./profile-service.js";
import {
  boolean,
  objectSchema,
  optionalString,
  requiredString,
  text,
  type ToolBuilder,
} from "../tools/tool-kit.js";

export class ProfileToolFactory {
  constructor(private readonly profile: UserProfileService) {}

  build(tool: ToolBuilder): AnyAgentTool[] {
    return [
      tool(
        "upsert_user_profile_field",
        "Сохранить поле профиля",
        "Сохраняет только явно сообщённое или хорошо подтверждённое сведение текущего пользователя. Чувствительные сведения остаются кандидатами до подтверждения.",
        objectSchema({
          field_key: text("Разрешённый ключ поля профиля"),
          value: { description: "Строка, массив строк или JSON-объект согласно типу поля" },
          source_quote: text("Короткая точная цитата пользователя"),
          confidence: { type: "number", minimum: 0, maximum: 1 },
          explicitly_stated: boolean("Пользователь сообщил это прямо, без интерпретации"),
        }, ["field_key", "value", "explicitly_stated"]),
        async (args, runtime) => ({
          ok: true,
          field: await this.profile.upsert({
            userId: runtime.userId,
            fieldKey: requiredString(args, "field_key", 100),
            value: args.value,
            sourceQuote: optionalString(args, "source_quote", 2_000),
            confidence: typeof args.confidence === "number" ? args.confidence : undefined,
            explicitlyStated: args.explicitly_stated === true,
            forceCandidate: runtime.purpose !== "chat",
          }),
        }),
      ),
      tool(
        "confirm_user_profile_field",
        "Подтвердить поле профиля",
        "Подтверждает существующий кандидат только после явного согласия пользователя.",
        objectSchema({ field_key: text("Ключ поля профиля") }, ["field_key"]),
        async (args, runtime) => ({
          ok: true,
          field: await this.profile.confirm(
            runtime.userId,
            requiredString(args, "field_key", 100),
          ),
        }),
      ),
      tool(
        "decline_user_profile_field",
        "Отклонить поле профиля",
        "Помечает поле отклонённым после явного отказа пользователя.",
        objectSchema({ field_key: text("Ключ поля профиля") }, ["field_key"]),
        async (args, runtime) => ({
          ok: true,
          field: await this.profile.decline(
            runtime.userId,
            requiredString(args, "field_key", 100),
          ),
        }),
      ),
      tool(
        "mark_profile_field_asked",
        "Отметить вопрос профиля",
        "Вызывается только если Ева действительно задала дополнительный вопрос; включает cooldown.",
        objectSchema({ field_key: text("Ключ заданного поля") }, ["field_key"]),
        async (args, runtime) => {
          const fieldKey = requiredString(args, "field_key", 100);
          await this.profile.markAsked(runtime.userId, fieldKey);
          return { ok: true, field_key: fieldKey };
        },
      ),
      tool(
        "get_user_profile",
        "Получить профиль",
        "Возвращает подтверждённые сведения и кандидаты только текущего пользователя.",
        objectSchema({}),
        async (_args, runtime) => ({
          ok: true,
          ...(await this.profile.getProfile(runtime.userId)),
        }),
      ),
    ];
  }
}
