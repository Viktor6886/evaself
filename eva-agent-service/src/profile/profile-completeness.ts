import type { Database } from "../db.js";

interface HintRow {
  field_key: string;
  title: string;
  prompt_hint: string;
  sensitivity: "normal" | "sensitive" | "high";
  status: string | null;
  field_value: string | null;
  field_json: unknown;
}

export interface ProfileHint {
  fieldKey: string;
  text: string;
  candidate: boolean;
}

export class ProfileCompletenessService {
  constructor(private readonly db: Database) {}

  async nextHint(userId: number, message: string): Promise<ProfileHint | null> {
    if (shouldSuppressProfileQuestion(message)) return null;
    const { rows } = await this.db.query<HintRow>(
      `SELECT
          d.field_key,
          d.title,
          d.prompt_hint,
          d.sensitivity,
          f.status,
          f.field_value,
          f.field_json
        FROM profile_field_definitions d
        LEFT JOIN onboarding_fields f
          ON f.user_id = $1 AND f.field_key = d.field_key
       WHERE d.enabled
         AND COALESCE(f.status, 'missing') NOT IN
             ('confirmed', 'declined', 'not_applicable', 'superseded')
         AND COALESCE(f.ask_count, 0) < d.max_ask_count
         AND (
           f.last_asked_at IS NULL
           OR f.last_asked_at <= now() - make_interval(days => d.cooldown_days)
         )
         AND d.sensitivity = 'normal'
       ORDER BY
         CASE WHEN f.status = 'candidate' THEN 0 ELSE 1 END,
         d.priority,
         d.sort_order
       LIMIT 1`,
      [userId],
    );
    const field = rows[0];
    if (!field) return null;
    if (field.status === "candidate") {
      return {
        fieldKey: field.field_key,
        candidate: true,
        text: [
          `Есть неподтверждённое сведение профиля «${field.title}».`,
          "Если это естественно связано с текущей темой, кратко попроси подтвердить или отклонить его.",
          "Не выдавай предположение за факт и не задавай больше одного дополнительного вопроса.",
        ].join(" "),
      };
    }
    return {
      fieldKey: field.field_key,
      candidate: false,
      text: [
        `У пользователя пока не заполнено поле профиля «${field.title}».`,
        field.prompt_hint,
        "Не задавай больше одного дополнительного вопроса и не нарушай естественный ход беседы.",
        `Если пользователь явно сообщит ответ, сохрани его инструментом профиля с field_key=${field.field_key}.`,
      ].join(" "),
    };
  }
}

export function shouldSuppressProfileQuestion(message: string): boolean {
  const text = message.toLocaleLowerCase("ru");
  return [
    /(?:суицид|самоубий|убить себя|не хочу жить|причинить себе вред)/u,
    /(?:срочно|немедленно|прямо сейчас).{0,40}(?:помоги|нужно|надо)/u,
    /(?:паническ|истерик|катастроф|угрожает|опасност)/u,
  ].some((pattern) => pattern.test(text));
}
