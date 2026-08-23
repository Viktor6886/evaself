/**
 * Что на самом деле видит нативный механизм навыков Letta.
 *
 * Аудит нужен потому, что «навык есть в репозитории» и «навык доступен
 * агенту» — разные утверждения, и расходятся они молча: каталог
 * монтируется в App Server отдельно, источников у Letta четыре, а
 * самоотчёт модели о собственных навыках ничего не подтверждает.
 *
 * Здесь нет ни выбора навыка, ни его подмены: выбирает Letta. Аудит
 * только перечисляет факты и честно отделяет перечислимое от
 * неперечислимого.
 *
 * Что перечислить можно: навыки проекта — они лежат в смонтированном
 * каталоге, и его читает тот же процесс. Что нельзя: bundled и global —
 * они живут на стороне App Server, и ни Agent SDK 0.7.1, ни клиент
 * 1.12.1 не отдают их состав. Поэтому коллизии ищутся среди
 * перечислимого, а про остальное аудит говорит «не перечисляется», а не
 * «нет».
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Двенадцать навыков Evaself. Один список на сервис, тесты и диагностику:
 * второй перечень разошёлся бы с первым на первом же добавлении.
 */
export const EVA_PROJECT_SKILLS = [
  "act",
  "behavioral-activation",
  "cbt",
  "crisis-response",
  "emotion-regulation",
  "goals-values",
  "journaling-reflection",
  "memory-hygiene",
  "motivational-interviewing",
  "relationships-boundaries",
  "schema-therapy",
  "therapeutic-conversation",
  "relational-presence",
] as const;

/** Источники, состав которых на установленных версиях не перечисляется. */
export const NOT_ENUMERABLE_SOURCES = ["bundled", "global", "agent"] as const;

export interface SkillEntry {
  /** `name` из frontmatter — именно по нему Letta различает навыки. */
  name: string;
  /** Каталог навыка. Имя каталога и `name` могут разойтись, и это тоже факт. */
  directory: string;
  /** Длина описания: по нему модель решает, открывать ли навык. */
  descriptionLength: number;
}

export interface SkillProblem {
  skill: string;
  reason: string;
}

export interface SkillsAuditResult {
  /** Источники навыков, названные самим runtime. `null` — не сообщил. */
  sources: string[] | null;
  /** Нативный `Skill` в составе инструментов сессии. `null` — состав не назван. */
  nativeSkillTool: boolean | null;
  /** Каталог проекта прочитан. */
  catalogAvailable: boolean;
  /** Навыки проекта, перечисленные штатным чтением каталога. */
  project: SkillEntry[];
  /** Каких навыков Evaself не хватает в каталоге. */
  missing: string[];
  /** Одинаковые `name` среди перечислимого. */
  collisions: Array<{ name: string; directories: string[] }>;
  /** Навык, который нативный механизм не прочитает. */
  problems: SkillProblem[];
  /** Источники, чей состав перечислить нечем. Не «пусто», а «не наблюдаем». */
  notEnumerable: string[];
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---/u;

/**
 * Прочитать каталог навыков проекта.
 *
 * Отсутствие каталога — не поломка: в образе сервиса его может не быть,
 * а смонтирован он только там, где действительно нужен. Разница между
 * «каталога нет» и «каталог пуст» сохраняется отдельным полем.
 */
export async function readProjectSkills(root: string): Promise<{
  available: boolean;
  skills: SkillEntry[];
  problems: SkillProblem[];
}> {
  let directories: string[];
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { available: false, skills: [], problems: [] };
  }

  const skills: SkillEntry[] = [];
  const problems: SkillProblem[] = [];
  for (const directory of directories) {
    let body: string;
    try {
      body = await readFile(join(root, directory, "SKILL.md"), "utf8");
    } catch {
      problems.push({ skill: directory, reason: "нет SKILL.md" });
      continue;
    }
    const frontmatter = FRONTMATTER.exec(body)?.[1];
    if (!frontmatter) {
      problems.push({ skill: directory, reason: "нет frontmatter" });
      continue;
    }
    const name = /^name:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim();
    const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim();
    if (!name) {
      problems.push({ skill: directory, reason: "нет name" });
      continue;
    }
    if (!description) {
      problems.push({ skill: directory, reason: "нет description" });
      continue;
    }
    skills.push({ name, directory, descriptionLength: description.length });
  }
  return { available: true, skills, problems };
}

/**
 * Свести факты о навыках воедино.
 *
 * `facts` приходят из `init`-сообщения SDK, `sessionTools` — из состава
 * инструментов сессии. Ни то, ни другое здесь не додумывается: не
 * сообщил runtime — значит `null`.
 */
export async function auditSkills(input: {
  root: string;
  sources: string[] | null;
  sessionTools: string[] | null;
}): Promise<SkillsAuditResult> {
  const catalog = await readProjectSkills(input.root);
  const byName = new Map<string, string[]>();
  for (const skill of catalog.skills) {
    byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill.directory]);
  }
  const present = new Set(catalog.skills.map((skill) => skill.name));
  return {
    sources: input.sources,
    nativeSkillTool: input.sessionTools === null ? null : input.sessionTools.includes("Skill"),
    catalogAvailable: catalog.available,
    project: catalog.skills,
    missing: catalog.available
      ? EVA_PROJECT_SKILLS.filter((name) => !present.has(name))
      : [...EVA_PROJECT_SKILLS],
    collisions: [...byName.entries()]
      .filter(([, directories]) => directories.length > 1)
      .map(([name, directories]) => ({ name, directories })),
    problems: catalog.problems,
    notEnumerable: [...NOT_ENUMERABLE_SOURCES],
  };
}
