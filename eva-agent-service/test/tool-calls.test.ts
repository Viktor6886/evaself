/**
 * Фактические вызовы инструментов.
 *
 * Проверяется ровно то, ради чего телеметрия написана: вызов виден по
 * потоку SDK, а не по словам модели; имя навыка берётся из аргумента и
 * не придумывается; результат связывается с вызовом по идентификатору, а
 * не по соседству в потоке.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { collectToolCalls, NATIVE_SKILL_TOOL } from "../dist/letta/tool-calls.js";
import { summarizeStream } from "../dist/letta.js";

test("настоящий вызов навыка виден с именем, идентификатором и run", () => {
  const calls = collectToolCalls([
    { type: "assistant", content: "сейчас посмотрю", uuid: "m1" },
    {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: NATIVE_SKILL_TOOL,
      toolInput: { skill: "cbt" },
      runId: "run-9",
    },
    { type: "tool_result", toolCallId: "call-1", content: "текст навыка", isError: false },
  ]);

  assert.deepEqual(calls, [{
    toolName: "Skill",
    skillName: "cbt",
    toolCallId: "call-1",
    runId: "run-9",
    succeeded: true,
  }]);
});

test("результат связывается по идентификатору вызова, а не по порядку", () => {
  const calls = collectToolCalls([
    { type: "tool_call", toolCallId: "a", toolName: "Skill", toolInput: { skill: "act" } },
    { type: "tool_call", toolCallId: "b", toolName: "web_search", toolInput: { query: "x" } },
    { type: "tool_result", toolCallId: "b", isError: true },
    { type: "tool_result", toolCallId: "a", isError: false },
  ]);

  assert.deepEqual(
    calls.map((call) => [call.toolCallId, call.succeeded]),
    [["a", true], ["b", false]],
  );
});

test("вызов без результата остаётся вызовом без выдуманного исхода", () => {
  const [call] = collectToolCalls([
    { type: "tool_call", toolCallId: "call-1", toolName: "Skill", toolInput: { skill: "act" } },
  ]);
  assert.equal(call?.succeeded, null, "исход без tool_result обязан остаться неизвестным");
});

test("имя навыка не придумывается, если SDK его не назвал", () => {
  const calls = collectToolCalls([
    { type: "tool_call", toolCallId: "call-1", toolName: "Skill", toolInput: {} },
    { type: "tool_call", toolCallId: "call-2", toolName: "Skill", toolInput: { skill: "" } },
    { type: "tool_call", toolCallId: "call-3", toolName: "Skill" },
  ]);
  assert.deepEqual(calls.map((call) => call.skillName), [null, null, null]);
});

test("поле skill у другого инструмента навыком не считается", () => {
  const [call] = collectToolCalls([
    { type: "tool_call", toolCallId: "call-1", toolName: "knowledge_search", toolInput: { skill: "cbt" } },
  ]);
  assert.equal(call?.skillName, null, "чужой аргумент записан как открытый навык");
});

test("в записи нет ни аргументов, ни содержимого навыка", () => {
  const secret = "человек написал очень личное";
  const calls = collectToolCalls([
    {
      type: "tool_call",
      toolCallId: "call-1",
      toolName: "Skill",
      toolInput: { skill: "cbt", context: secret },
    },
    { type: "tool_result", toolCallId: "call-1", content: `# Навык КПТ\n${secret}`, isError: false },
  ]);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(calls), /Навык КПТ/);
});

test("разбор хода отдаёт вызовы вместе с остальным итогом", () => {
  const result = summarizeStream([
    { type: "assistant", content: "готово", uuid: "m1" },
    { type: "tool_call", toolCallId: "call-1", toolName: "Skill", toolInput: { skill: "goals-values" } },
    { type: "tool_result", toolCallId: "call-1", isError: false },
  ] as never);

  assert.equal(result.toolCallRecords.length, 1);
  assert.equal(result.toolCallRecords[0]?.skillName, "goals-values");
});
