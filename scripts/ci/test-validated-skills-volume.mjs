import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FilesystemSkillIndexer } from "/app/dist/skills/index.js";

const source = "/tmp/fixtures";
const runtime = "/data/letta/.skills";
const valid = (generation) => `---\nname: lifecycle\ncategory: core\nrole: primary\norder: 1\nsafety: true\n---\ngeneration-${generation}\n`;

async function resetSource(generation) {
  await rm(source, { recursive: true, force: true });
  await mkdir(join(source, "valid"), { recursive: true });
  await mkdir(join(source, "malformed"), { recursive: true });
  await writeFile(join(source, "valid", "SKILL.md"), valid(generation));
  await writeFile(join(source, "malformed", "SKILL.md"), "not frontmatter\n");
}

function indexer() {
  return new FilesystemSkillIndexer({
    async syncIndexedSkill() {},
  }, { root: source, runtimeRoot: runtime, environment: "production" });
}

const phase = process.argv[2];
if (phase === "cold") {
  await resetSource("one");
  assert.deepEqual(await indexer().sync(), { active: 1, disabled: 1 });
  assert.equal(await readFile(join(runtime, "valid", "SKILL.md"), "utf8"), valid("one"));
  await assert.rejects(readFile(join(runtime, "malformed", "SKILL.md"), "utf8"));
} else if (phase === "failed") {
  await resetSource("failed-must-not-publish");
  await chmod(join(runtime, "valid"), 0o500);
  await assert.rejects(indexer().sync(), /EACCES|permission denied/);
  await chmod(join(runtime, "valid"), 0o750);
  assert.equal(await readFile(join(runtime, "valid", "SKILL.md"), "utf8"), valid("one"));
} else if (phase === "update") {
  await resetSource("two");
  assert.deepEqual(await indexer().sync(), { active: 1, disabled: 1 });
  const bytes = await readFile(join(runtime, "valid", "SKILL.md"), "utf8");
  assert.equal(bytes, valid("two"));
  assert.ok(bytes.length > 0);
  await chmod(join(runtime, "valid", "SKILL.md"), 0o444);
} else {
  throw new Error(`unknown phase: ${phase}`);
}
