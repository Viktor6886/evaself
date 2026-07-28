import assert from "node:assert/strict";
import { test } from "node:test";

import { safeAdminValue } from "../dist/server.js";

test("administrative agent projection masks environment values and keys", () => {
  const safe = safeAdminValue({
    id: "agent-1",
    model_settings: {
      temperature: 0.2,
      api_key: "model-secret",
    },
    secrets: [
      { key: "TODOIST_API_TOKEN", value: "agent-secret", description: "configured" },
    ],
    tool_exec_environment_variables: {
      CUSTOM_ENDPOINT: "https://private.example/secret-path",
      DATABASE_URL: "postgresql://secret",
    },
  }) as {
    model_settings: Record<string, unknown>;
    secrets: Array<Record<string, unknown>>;
    tool_exec_environment_variables: Record<string, unknown>;
  };

  assert.equal(safe.model_settings.temperature, 0.2);
  assert.equal(safe.model_settings.api_key, "[скрыто]");
  assert.equal(safe.secrets[0]?.value, "[скрыто]");
  assert.equal(safe.secrets[0]?.configured, true);
  assert.equal(safe.tool_exec_environment_variables.DATABASE_URL, "[скрыто]");
  assert.doesNotMatch(JSON.stringify(safe), /model-secret|agent-secret|private\.example|postgresql/);
});
