import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(process.cwd(), "..");
const example = resolve(root, ".env.example");
const migrate = resolve(root, "scripts/ensure-env-defaults.sh");
const repositorySourcesAvailable = existsSync(example) && existsSync(migrate);
const repositoryOnly = {
  skip: repositorySourcesAvailable
    ? false
    : "repository .env.example and scripts are outside the service-only Docker build context",
};

function runMigration(envFile: string, exampleFile: string): void {
  execFileSync("bash", [migrate], {
    cwd: root,
    env: {
      ...process.env,
      ENV_FILE: envFile,
      EXAMPLE_FILE: exampleFile,
      NO_COLOR: "1",
    },
    stdio: "pipe",
  });
}

function valueOf(text: string, key: string): string | null {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : null;
}

test("новая установка включает пользовательские окна инициативы", repositoryOnly, () => {
  const contents = readFileSync(example, "utf8");
  assert.equal(valueOf(contents, "EVA_PROACTIVE_INITIATIVE"), "true");
});

test("обновление исправляет старое штатное false только один раз", repositoryOnly, () => {
  const dir = mkdtempSync(resolve(tmpdir(), "evaself-proactive-config-"));
  const envFile = resolve(dir, ".env");
  const exampleFile = resolve(dir, ".env.example");
  try {
    writeFileSync(exampleFile, "EVA_PROACTIVE_INITIATIVE=true\n", "utf8");
    writeFileSync(envFile, "EVA_PROACTIVE_INITIATIVE=false\n", "utf8");

    runMigration(envFile, exampleFile);
    let migrated = readFileSync(envFile, "utf8");
    assert.equal(valueOf(migrated, "EVA_PROACTIVE_INITIATIVE"), "true");
    assert.match(migrated, /evaself-default-migrated: EVA_PROACTIVE_INITIATIVE=true/);

    // После одноразовой миграции флаг снова является аварийным ручным
    // выключателем: следующий update не должен отменять решение оператора.
    migrated = migrated.replace(
      /^EVA_PROACTIVE_INITIATIVE=true$/m,
      "EVA_PROACTIVE_INITIATIVE=false",
    );
    writeFileSync(envFile, migrated, "utf8");
    runMigration(envFile, exampleFile);
    assert.equal(
      valueOf(readFileSync(envFile, "utf8"), "EVA_PROACTIVE_INITIATIVE"),
      "false",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("отсутствующий флаг добавляется включённым", repositoryOnly, () => {
  const dir = mkdtempSync(resolve(tmpdir(), "evaself-proactive-config-"));
  const envFile = resolve(dir, ".env");
  const exampleFile = resolve(dir, ".env.example");
  try {
    writeFileSync(exampleFile, "EVA_PROACTIVE_INITIATIVE=true\n", "utf8");
    writeFileSync(envFile, "DOMAIN=evaself.localhost\n", "utf8");
    runMigration(envFile, exampleFile);
    assert.equal(
      valueOf(readFileSync(envFile, "utf8"), "EVA_PROACTIVE_INITIATIVE"),
      "true",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
