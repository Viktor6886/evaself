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
import { existsSync, readFileSync } from "node:fs";
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

test("тринадцать навыков проекта читаются нативным способом", async (context) => {
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

test("знаменатель «нашли N из M» приходит из канонического списка", async (context) => {
  // В doctor.sh это число было вписано руками и устарело: навыков стало
  // тринадцать, а знаменатель остался двенадцатью, и здоровая установка
  // печатала «13/12» — вид отказа там, где его нет. Второй рукописной
  // копии больше нет, и этот тест сторожит именно её отсутствие.
  const audit = await auditSkills({
    root: REPO_SKILLS,
    sources: ["project"],
    sessionTools: ["Skill"],
  });
  assert.equal(audit.expected, audit.project.length + audit.missing.length);

  // Главное здесь — не равенство выше, а отсутствие второй копии числа.
  // `doctor.sh` работает на сервере и TypeScript-тестами не покрыт, поэтому
  // знаменатель сторожится отсюда: он обязан приходить из ответа рантайма.
  //
  // В образе сервиса каталога `scripts/` нет — он не входит в контекст
  // сборки. Пропуск там честнее выдуманного PASS: проверка выполняется
  // на репозитории, где файл есть.
  const path = new URL("../../scripts/doctor.sh", import.meta.url);
  if (!existsSync(path)) {
    context.skip("doctor.sh вне образа; проверяется на репозитории");
    return;
  }
  const doctor = readFileSync(path, "utf8");
  assert.doesNotMatch(
    doctor,
    /skills=%d\/\d+/,
    "в doctor.sh снова вписан знаменатель числом — он устареет вместе со списком навыков",
  );
  assert.match(doctor, /skills\.get\("expected"\)/);
});
