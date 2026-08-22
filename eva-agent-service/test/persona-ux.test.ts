import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CoreToolFactory } from "../dist/tools/core-tools.js";

const tool = (
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (args: Record<string, unknown>, runtime: unknown) => Promise<unknown>,
) => ({ name, label, description, parameters, execute });

function descriptions(): Map<string, string> {
  const factory = new CoreToolFactory(
    { routerUrl: "", routerApiKey: "", skillsDir: "/nonexistent" } as never,
    { withUserScope: async <T>(_s: unknown, work: () => Promise<T>) => await work() } as never,
    {} as never,
  );
  return new Map(factory.build(tool as never).map((item) => [item.name, item.description]));
}

test("persona file is structurally valid editable UTF-8 content", async (t) => {
  let persona: string;
  try {
    persona = await readFile(new URL("../../library/persona/eva.md", import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    t.skip("persona is outside the service-only Docker build context");
    return;
  }
  assert.ok(persona.trim().length > 0);
  assert.ok(Buffer.byteLength(persona, "utf8") <= 1_000_000);
});

test("typed tool descriptions make reaction and buttons the active default when appropriate", () => {
  const tools = descriptions();
  assert.match(tools.get("set_reaction") ?? "", /по умолчанию рассмотри/i);
  assert.match(tools.get("set_reaction") ?? "", /горе или кризис/i);
  assert.match(tools.get("present_inline_choices") ?? "", /2–6 вариантов/);
  assert.match(tools.get("present_inline_choices") ?? "", /Открытый вопрос/i);
});
