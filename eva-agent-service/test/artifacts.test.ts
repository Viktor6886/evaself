/**
 * Единый реестр артефактов: правила версий, публикации и отката.
 *
 * Что здесь НЕ проверяется и не притворяется проверенным: неизменяемость
 * версии. Она держится триггером в схеме, а поддельная база выполнит любой
 * UPDATE, который ей напишут. Эта гарантия проверяется на настоящем
 * PostgreSQL в `scripts/ci/test-artifact-immutability.sql`.
 *
 * Здесь — то, что решает код: валидация содержимого по типу, запрет
 * публиковать неутверждённое, откат указателем, семантический diff без
 * содержимого и фиксация версий прогоном.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ARTIFACT_KINDS,
  artifactChecksum,
  diffArtifactBodies,
  validateArtifactBody,
} from "../dist/artifacts/validation.js";
import { ArtifactRegistry } from "../dist/artifacts/registry.js";

// --------------------------------------------------------------------
// содержимое версии
// --------------------------------------------------------------------

test("отпечаток не зависит от порядка ключей", () => {
  assert.equal(
    artifactChecksum({ a: 1, b: { c: 2, d: 3 } }),
    artifactChecksum({ b: { d: 3, c: 2 }, a: 1 }),
  );
  assert.notEqual(artifactChecksum({ a: 1 }), artifactChecksum({ a: 2 }));
});

test("шаблон memory block не расширяет ядро памяти", () => {
  // Инвариант 28 проще всего нарушить именно шаблоном: он выглядит как
  // безобидные данные и попадает в новых агентов целиком.
  assert.throws(
    () => validateArtifactBody("memory_block_template", {
      blocks: [{ label: "persona", value: "x" }, { label: "fifth_block", value: "y" }],
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "bad_request");
      // Сообщение называет ядро поимённо: «вне набора» без списка
      // не говорит администратору, какие метки допустимы.
      assert.match((error as Error).message, /вне ядра памяти/);
      assert.match((error as Error).message, /persona.*therapeutic_framework/s);
      return true;
    },
  );

  const ok = validateArtifactBody("memory_block_template", {
    blocks: [
      { label: "persona", value: "персона" },
      { label: "human", value: "человек", limit: 10_000 },
    ],
  });
  assert.equal(ok.ok, true);
});

test("повтор метки в шаблоне отвергается", () => {
  assert.throws(() => validateArtifactBody("memory_block_template", {
    blocks: [{ label: "persona", value: "a" }, { label: "persona", value: "b" }],
  }), /повторяется/);
});

test("каждый тип артефакта имеет собственную проверку содержимого", () => {
  assert.throws(() => validateArtifactBody("prompt", { text: "  " }), /prompt.text/);
  assert.throws(() => validateArtifactBody("flow", { steps: [] }), /flow.steps/);
  assert.throws(() => validateArtifactBody("flow", { steps: [{}] }), /без имени/);
  assert.throws(() => validateArtifactBody("skill", { name: "x" }), /skill.source/);
  assert.throws(() => validateArtifactBody("policy", { rules: [] }), /policy.rules/);
  assert.equal(validateArtifactBody("prompt", { text: "привет" }).ok, true);
  // Prompt и flow — независимые типы, а не два имени одного.
  assert.throws(() => validateArtifactBody("flow", { text: "привет" }), /flow.steps/);
  assert.equal(ARTIFACT_KINDS.length, 5);
});

test("diff показывает пути и размеры, но не содержимое", () => {
  const secret = "очень личный текст пользователя";
  const entries = diffArtifactBodies(
    { blocks: { persona: "старое" }, limit: 10 },
    { blocks: { persona: secret }, extra: true },
  );
  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes(secret), false, "diff не показывает содержимое");
  assert.deepEqual(entries.map((entry) => `${entry.path}:${entry.change}`), [
    "blocks.persona:changed",
    "extra:added",
    "limit:removed",
  ]);
});

// --------------------------------------------------------------------
// реестр
// --------------------------------------------------------------------

interface Version {
  id: number;
  artifact_id: number;
  version: number;
  body: unknown;
  checksum: string;
  parent_id: number | null;
  status: string;
  validation: unknown;
  test_result: unknown;
  created_at: string;
}

interface Publication {
  id: number;
  artifact_id: number;
  environment: string;
  version_id: number;
  rollout_percent: number;
  previous_version_id: number | null;
  published_at: string;
  reason: string;
  retired_at: string | null;
}

/**
 * Поддельная база, повторяющая правила выборки реестра.
 *
 * Неизменяемость она НЕ изображает: делать вид, что фейк запрещает UPDATE,
 * значило бы проверять фейк. За это отвечает SQL-тест в CI.
 */
class FakeArtifactDatabase {
  artifacts: Array<{ id: number; kind: string; slug: string; title: string; description: string; archived_at: null }> = [];
  versions: Version[] = [];
  publications: Publication[] = [];
  private seq = 0;

  private next(): number {
    this.seq += 1;
    return this.seq;
  }

  query = async (sql: string, values: unknown[] = []) => {
    const text = sql.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim();

    if (text.startsWith("SELECT id, kind, slug, title, description, archived_at FROM artifacts WHERE id")) {
      const found = this.artifacts.filter((row) => row.id === Number(values[0]));
      return { rows: found as unknown as Record<string, unknown>[], rowCount: found.length };
    }
    if (text.startsWith("SELECT id, kind, slug")) {
      const kind = values[0] as string | null;
      const found = this.artifacts.filter((row) => kind === null || row.kind === kind);
      return { rows: found as unknown as Record<string, unknown>[], rowCount: found.length };
    }
    if (text.startsWith("INSERT INTO artifacts")) {
      const [kind, slug, title, description] = values as [string, string, string, string];
      if (this.artifacts.some((row) => row.kind === kind && row.slug === slug)) {
        return { rows: [], rowCount: 0 };
      }
      const row = { id: this.next(), kind, slug, title, description, archived_at: null };
      this.artifacts.push(row);
      return { rows: [row] as unknown as Record<string, unknown>[], rowCount: 1 };
    }
    if (text.startsWith("SELECT id, checksum, version FROM artifact_versions")) {
      const found = this.versions
        .filter((row) => row.artifact_id === Number(values[0]))
        .sort((a, b) => b.version - a.version)
        .slice(0, 1);
      return { rows: found as unknown as Record<string, unknown>[], rowCount: found.length };
    }
    if (text.startsWith("INSERT INTO artifact_versions")) {
      const [artifactId, body, checksum, parentId, validation] = values as [
        number, string, string, number | null, string,
      ];
      const highest = this.versions
        .filter((row) => row.artifact_id === artifactId)
        .reduce((max, row) => Math.max(max, row.version), 0);
      const row: Version = {
        id: this.next(),
        artifact_id: artifactId,
        version: highest + 1,
        body: JSON.parse(body),
        checksum,
        parent_id: parentId,
        status: "draft",
        validation: JSON.parse(validation),
        test_result: null,
        created_at: new Date().toISOString(),
      };
      this.versions.push(row);
      return { rows: [row] as unknown as Record<string, unknown>[], rowCount: 1 };
    }
    if (text.startsWith("SELECT id, artifact_id, version, body")) {
      const byId = text.includes("WHERE id = $1");
      const found = byId
        ? this.versions.filter((row) => row.id === Number(values[0]))
        : this.versions
          .filter((row) => row.artifact_id === Number(values[0]))
          .sort((a, b) => b.version - a.version);
      return { rows: found as unknown as Record<string, unknown>[], rowCount: found.length };
    }
    if (text.startsWith("UPDATE artifact_versions SET status")) {
      const row = this.versions.find((item) => item.id === Number(values[0]));
      if (row) row.status = String(values[1]);
      return { rows: (row ? [row] : []) as unknown as Record<string, unknown>[], rowCount: row ? 1 : 0 };
    }
    if (text.startsWith("SELECT p.id, p.artifact_id")) {
      const active = text.includes("p.retired_at IS NULL");
      const found = this.publications
        .filter((row) => row.artifact_id === Number(values[0]) && row.environment === values[1])
        .filter((row) => (active ? row.retired_at === null : true))
        .sort((a, b) => b.id - a.id)
        .map((row) => ({
          ...row,
          version: this.versions.find((item) => item.id === row.version_id)?.version ?? 0,
        }));
      return { rows: found as unknown as Record<string, unknown>[], rowCount: found.length };
    }
    if (text.startsWith("INSERT INTO artifact_publications")) {
      const [artifactId, environment, versionId, rollout, previous, , reason] = values as [
        number, string, number, number, number | null, string | null, string,
      ];
      if (this.publications.some(
        (row) => row.artifact_id === artifactId && row.environment === environment && row.retired_at === null,
      )) {
        throw new Error("duplicate key value violates unique constraint");
      }
      const row: Publication = {
        id: this.next(),
        artifact_id: artifactId,
        environment,
        version_id: versionId,
        rollout_percent: rollout,
        previous_version_id: previous,
        published_at: new Date().toISOString(),
        reason: reason ?? "",
        retired_at: null,
      };
      this.publications.push(row);
      return { rows: [row] as unknown as Record<string, unknown>[], rowCount: 1 };
    }
    if (text.startsWith("SELECT p.version_id, p.rollout_percent")) {
      const [kind, slug, environment] = values as [string, string, string];
      const artifact = this.artifacts.find((row) => row.kind === kind && row.slug === slug);
      const found = this.publications
        .filter((row) => row.artifact_id === artifact?.id
          && row.environment === environment && row.retired_at === null)
        .map((row) => {
          const version = this.versions.find((item) => item.id === row.version_id);
          return {
            version_id: row.version_id,
            rollout_percent: row.rollout_percent,
            version: version?.version ?? 0,
            checksum: version?.checksum ?? "",
            body: version?.body ?? null,
          };
        });
      return { rows: found as unknown as Record<string, unknown>[], rowCount: found.length };
    }
    if (text.startsWith("UPDATE artifact_publications SET retired_at")) {
      const row = this.publications.find((item) => item.id === Number(values[0]));
      if (row && row.retired_at === null) row.retired_at = new Date().toISOString();
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`Неожиданный запрос: ${text.slice(0, 70)}`);
  };
}

async function seeded() {
  const db = new FakeArtifactDatabase();
  const registry = new ArtifactRegistry(db as never);
  const artifact = await registry.create({ kind: "prompt", slug: "eva.persona", title: "Персона" });
  return { db, registry, artifact };
}

test("артефакт с тем же типом и slug не заводится дважды", async () => {
  const { registry } = await seeded();
  await assert.rejects(
    () => registry.create({ kind: "prompt", slug: "eva.persona", title: "Дубль" }),
    /уже существует/,
  );
});

test("версия наследует родителя и не повторяет содержимое", async () => {
  const { registry, artifact } = await seeded();
  const first = await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } });
  assert.equal(first.version.version, 1);
  assert.equal(first.version.parentId, null);
  assert.equal(first.version.status, "draft");

  const second = await registry.createVersion({ artifactId: artifact.id, body: { text: "v2" } });
  assert.equal(second.version.version, 2);
  assert.equal(second.version.parentId, first.version.id);

  // Версия, ничем не отличающаяся от предыдущей, делает откат неоднозначным.
  await assert.rejects(
    () => registry.createVersion({ artifactId: artifact.id, body: { text: "v2" } }),
    /совпадает с предыдущей/,
  );
});

test("непрошедшее проверку содержимое не создаёт версию", async () => {
  const { registry, artifact, db } = await seeded();
  await assert.rejects(() => registry.createVersion({ artifactId: artifact.id, body: { text: "" } }));
  assert.equal(db.versions.length, 0, "отклонённая версия не должна оставлять строку");
});

test("публикуется только утверждённая версия", async () => {
  const { registry, artifact } = await seeded();
  const { version } = await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } });

  await assert.rejects(
    () => registry.publish({ artifactId: artifact.id, environment: "production", versionId: version.id }),
    /публикуется только утверждённая/,
  );

  await registry.setStatus(version.id, "candidate");
  await assert.rejects(
    () => registry.publish({ artifactId: artifact.id, environment: "production", versionId: version.id }),
    /публикуется только утверждённая/,
  );

  await registry.setStatus(version.id, "approved");
  const published = await registry.publish({
    artifactId: artifact.id, environment: "production", versionId: version.id,
  });
  assert.equal(published.versionId, version.id);
  assert.equal(published.rolloutPercent, 100);
});

test("жизненный цикл движется только вперёд", async () => {
  const { registry, artifact } = await seeded();
  const { version } = await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } });
  await registry.setStatus(version.id, "approved");
  await assert.rejects(() => registry.setStatus(version.id, "candidate"), /только вперёд/);
});

test("откат возвращает прежнюю версию и не переписывает историю", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  const v2 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v2" } })).version;
  await registry.setStatus(v1.id, "approved");
  await registry.setStatus(v2.id, "approved");

  await registry.publish({ artifactId: artifact.id, environment: "production", versionId: v1.id });
  await registry.publish({ artifactId: artifact.id, environment: "production", versionId: v2.id });

  const back = await registry.rollback({
    artifactId: artifact.id, environment: "production", reason: "ответы стали хуже",
  });
  assert.equal(back.versionId, v1.id);
  assert.equal((await registry.active(artifact.id, "production"))?.versionId, v1.id);

  const history = await registry.history(artifact.id, "production");
  assert.equal(history.length, 3, "откат добавляет публикацию, а не удаляет предыдущую");
  assert.equal(history.filter((row) => row.retiredAt === null).length, 1);

  // Откат отката тоже работает: указатель, а не разрушение истории.
  const forward = await registry.rollback({
    artifactId: artifact.id, environment: "production", reason: "вернули обратно",
  });
  assert.equal(forward.versionId, v2.id);
  assert.equal((await registry.history(artifact.id, "production")).length, 4);
});

test("первая публикация не откатывается, а откат требует причины", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  await registry.setStatus(v1.id, "approved");

  await assert.rejects(
    () => registry.rollback({ artifactId: artifact.id, environment: "production", reason: "нет публикации" }),
    /нечего откатывать/,
  );

  // Первая публикация: откатывать не на что, и это сообщается сразу —
  // гонять оператора за причиной ради заведомого тупика незачем.
  await registry.publish({ artifactId: artifact.id, environment: "production", versionId: v1.id });
  await assert.rejects(
    () => registry.rollback({ artifactId: artifact.id, environment: "production", reason: "с причиной" }),
    /откатывать не на что/,
  );

  // Причина требуется там, где откат вообще возможен.
  const v2 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v2" } })).version;
  await registry.setStatus(v2.id, "approved");
  await registry.publish({ artifactId: artifact.id, environment: "production", versionId: v2.id });
  await assert.rejects(
    () => registry.rollback({ artifactId: artifact.id, environment: "production", reason: "  " }),
    /требует причины/,
  );
});

test("окружения независимы", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  const v2 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v2" } })).version;
  await registry.setStatus(v1.id, "approved");
  await registry.setStatus(v2.id, "approved");

  await registry.publish({ artifactId: artifact.id, environment: "production", versionId: v1.id });
  await registry.publish({
    artifactId: artifact.id, environment: "canary", versionId: v2.id, rolloutPercent: 10,
  });

  assert.equal((await registry.active(artifact.id, "production"))?.versionId, v1.id);
  const canary = await registry.active(artifact.id, "canary");
  assert.equal(canary?.versionId, v2.id);
  assert.equal(canary?.rolloutPercent, 10);
});

test("процент раскатки проверяется", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  await registry.setStatus(v1.id, "approved");
  for (const rollout of [-1, 101, 3.5]) {
    await assert.rejects(
      () => registry.publish({
        artifactId: artifact.id, environment: "production", versionId: v1.id, rolloutPercent: rollout,
      }),
      /целое число от 0 до 100/,
    );
  }
});

test("версия чужого артефакта не публикуется", async () => {
  const { registry, artifact } = await seeded();
  const other = await registry.create({ kind: "policy", slug: "eva.limits", title: "Пределы" });
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  await registry.setStatus(v1.id, "approved");
  await assert.rejects(
    () => registry.publish({ artifactId: other.id, environment: "production", versionId: v1.id }),
    /другому артефакту/,
  );
});

// --------------------------------------------------------------------
// разрешение версии во время выполнения
// --------------------------------------------------------------------

test("разрешение версии отдаёт содержимое действующей публикации", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  await registry.setStatus(v1.id, "approved");
  await registry.publish({ artifactId: artifact.id, environment: "production", versionId: v1.id });

  const resolved = await registry.resolve({
    kind: "prompt", slug: "eva.persona", environment: "production", subject: "user-1",
  });
  assert.equal(resolved?.versionId, v1.id);
  assert.deepEqual(resolved?.body, { text: "v1" });

  // Другого окружения публикация не касается.
  assert.equal(
    await registry.resolve({
      kind: "prompt", slug: "eva.persona", environment: "canary", subject: "user-1",
    }),
    null,
  );
});

test("нулевая раскатка объявлена, но никому не выдаётся", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  await registry.setStatus(v1.id, "approved");
  await registry.publish({
    artifactId: artifact.id, environment: "production", versionId: v1.id, rolloutPercent: 0,
  });
  assert.equal(await registry.active(artifact.id, "production") === null, false);
  assert.equal(
    await registry.resolve({
      kind: "prompt", slug: "eva.persona", environment: "production", subject: "user-1",
    }),
    null,
  );
});

test("частичная раскатка устойчива для субъекта и делит выборку по проценту", async () => {
  const { registry, artifact } = await seeded();
  const v1 = (await registry.createVersion({ artifactId: artifact.id, body: { text: "v1" } })).version;
  await registry.setStatus(v1.id, "approved");
  await registry.publish({
    artifactId: artifact.id, environment: "production", versionId: v1.id, rolloutPercent: 25,
  });

  const ask = async (subject: string) => await registry.resolve({
    kind: "prompt", slug: "eva.persona", environment: "production", subject,
  });

  // Тот же субъект — тот же ответ: раскатка не должна мерцать между ходами.
  const first = await ask("user-42");
  const second = await ask("user-42");
  assert.equal(first === null, second === null);

  let included = 0;
  for (let i = 0; i < 400; i += 1) {
    if (await ask(`user-${i}`) !== null) included += 1;
  }
  // Ровно 25 % ждать не приходится: важно, что раскатка действительно
  // делит выборку, а не выдаёт версию всем или никому.
  assert.ok(included > 60 && included < 140, `в раскатку попало ${included} из 400`);
});
