import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProfileCompletenessService,
  shouldSuppressProfileQuestion,
} from "../dist/profile/profile-completeness.js";
import {
  UserProfileService,
  normalizeProfileValue,
} from "../dist/profile/profile-service.js";

test("profile arrays are normalized and deduplicated", () => {
  assert.deepEqual(
    normalizeProfileValue(
      ["  Радиотехника ", "радиотехника", "ИИ", "", "Путешествия"],
      "string_array",
    ),
    {
      text: null,
      json: ["Радиотехника", "ИИ", "Путешествия"],
    },
  );
});

test("normal explicit facts are confirmed while sensitive facts remain candidates", async () => {
  const savedStatuses: string[] = [];
  const definitions = new Map([
    ["interests", definition("interests", "string_array", "normal", false)],
    ["typical_obstacles", definition("typical_obstacles", "string_array", "sensitive", true)],
  ]);
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM profile_field_definitions WHERE field_key")) {
        return { rows: [definitions.get(String(values[0]))] };
      }
      if (sql.includes("INSERT INTO onboarding_fields")) {
        const status = String(values[4]);
        savedStatuses.push(status);
        return {
          rows: [{
            id: "1",
            field_key: values[1],
            field_value: values[2],
            field_json: values[3] ? JSON.parse(String(values[3])) : null,
            status,
            confidence: String(values[5]),
            source_type: values[6],
            source_id: values[7],
            source_quote: values[8],
            last_asked_at: null,
            ask_count: 0,
            declined_at: null,
            confirmed_at: status === "confirmed" ? new Date() : null,
            sensitivity: values[9],
            meta: {},
            updated_at: new Date(),
          }],
        };
      }
      return { rows: [] };
    },
  };
  const profile = new UserProfileService(db as never);

  await profile.upsert({
    userId: 1,
    fieldKey: "interests",
    value: ["ИИ", "путешествия"],
    explicitlyStated: true,
  });
  await profile.upsert({
    userId: 1,
    fieldKey: "typical_obstacles",
    value: ["откладывание"],
    explicitlyStated: true,
  });

  assert.deepEqual(savedStatuses, ["confirmed", "candidate"]);
});

test("profile hint is suppressed during a crisis and selects no more than one field", async () => {
  let queries = 0;
  const service = new ProfileCompletenessService({
    query: async () => {
      queries += 1;
      return {
        rows: [{
          field_key: "interests",
          title: "Интересы",
          prompt_hint: "Спроси естественно.",
          sensitivity: "normal",
          status: null,
          field_value: null,
          field_json: null,
        }],
      };
    },
  } as never);

  assert.equal(
    await service.nextHint(1, "Мне срочно нужна помощь, я не хочу жить"),
    null,
  );
  assert.equal(queries, 0);
  const hint = await service.nextHint(1, "Я выбираю новое хобби на выходные");
  assert.equal(hint?.fieldKey, "interests");
  assert.equal(queries, 1);
  assert.equal(shouldSuppressProfileQuestion("обычная беседа"), false);
});

function definition(
  fieldKey: string,
  valueType: "string" | "string_array" | "object",
  sensitivity: "normal" | "sensitive" | "high",
  confirmationRequired: boolean,
) {
  return {
    field_key: fieldKey,
    title: fieldKey,
    value_type: valueType,
    priority: 1,
    required_level: "optional",
    sensitivity,
    prompt_hint: "",
    confirmation_required: confirmationRequired,
    cooldown_days: 1,
    max_ask_count: 1,
    enabled: true,
    sort_order: 1,
  };
}
