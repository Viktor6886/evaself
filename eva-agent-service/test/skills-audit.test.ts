/**
 * Аудит навыков.
 *
 * Проверяется ровно та граница, ради которой аудит и написан: что можно
 * перечислить штатно, то перечисляется; чего перечислить нечем, то
 * называется неперечислимым, а не «отсутствующим». Выбор навыка здесь не
 * проверяется, потому что его здесь и нет: выбирает Letta.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVA_PROJECT_SKILLS,
  auditSkills,
  readProjectSkills,
} from "../dist/letta/skills-audit.js";

const REPO_SKILLS = new URL("../../skills/", import.meta.url).pathname;

async function catalog(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eva-skills-"));
  for (const [name, body] of Object.entries(entries)) {
    await mkdir(join(root, name), { recursive: true });
    if (body) await writeFile(join(root, name, "SKILL.md"), body, "utf8");
  }
  return root;
}

const skill = (name: string, description = "когда открывать этот навык") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

test("двенадцать навыков проекта читаются нативным способом", async (context) => {
  const found = await readProjectSkills(REPO_SKILLS);
  if (!found.available) {
    // Каталог монтируется отдельно и в образе сервиса его нет.
    context.skip("каталог навыков вне образа; проверяется на репозитории");
    return;
  }
  assert.deepEqual(found.problems, [], "навык, который нативный механизм не прочитает");
  const names = found.skills.map((entry) => entry.name).sort();
  assert.deepEqual(names, [...EVA_PROJECT_SKILLS].sort());
  // Описание — то, по чему модель решает открывать навык. Пустое или
  // односложное не различает навыки между собой.
  for (const entry of found.skills) {
    assert.ok(entry.descriptionLength >= 40, `${entry.name}: описание слишком короткое`);
    assert.ok(entry.descriptionLength <= 400, `${entry.name}: описание разрослось`);
  }
});

test("несколько источников навыков — норма, а не коллизия", async () => {
  const root = await catalog(Object.fromEntries(
    EVA_PROJECT_SKILLS.map((name) => [name, skill(name)]),
  ));
  const audit = await auditSkills({
    root,
    sources: ["bundled", "global", "project", "agent"],
    sessionTools: ["Skill", "memory_replace"],
  });

  assert.deepEqual(audit.sources, ["bundled", "global", "project", "agent"]);
  assert.equal(audit.nativeSkillTool, true);
  assert.deepEqual(audit.missing, []);
  assert.deepEqual(audit.collisions, [], "четыре источника сами по себе не коллизия");
  assert.deepEqual(audit.notEnumerable, ["bundled", "global", "agent"]);
});

test("коллизия объявляется по факту, а не по догадке об источниках", async () => {
  const root = await catalog({
    cbt: skill("cbt"),
    "cbt-copy": skill("cbt"),
  });
  const audit = await auditSkills({ root, sources: ["project"], sessionTools: [] });

  assert.deepEqual(audit.collisions, [{ name: "cbt", directories: ["cbt", "cbt-copy"] }]);
  assert.equal(audit.nativeSkillTool, false, "нативного Skill в наборе нет — это факт, а не null");
});

test("невалидный SKILL.md называется, а не пропускается молча", async () => {
  const root = await catalog({
    act: skill("act"),
    "no-frontmatter": "# просто заголовок\n",
    "no-file": "",
  });
  const audit = await auditSkills({ root, sources: null, sessionTools: null });

  assert.deepEqual(
    audit.problems.sort((left, right) => left.skill.localeCompare(right.skill)),
    [{ skill: "no-file", reason: "нет SKILL.md" }, { skill: "no-frontmatter", reason: "нет frontmatter" }],
  );
  // Runtime промолчал о составе — значит `null`, а не выдуманное «нет».
  assert.equal(audit.sources, null);
  assert.equal(audit.nativeSkillTool, null);
});

test("недоступный каталог не выдаётся за пустой", async () => {
  const audit = await auditSkills({
    root: join(tmpdir(), "eva-skills-которого-нет"),
    sources: ["project"],
    sessionTools: ["Skill"],
  });
  assert.equal(audit.catalogAvailable, false);
  assert.deepEqual(audit.project, []);
  assert.deepEqual(audit.missing, [...EVA_PROJECT_SKILLS]);
});
