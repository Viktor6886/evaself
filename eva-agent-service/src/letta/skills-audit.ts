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
 * Навыки Evaself. Один список на сервис, тесты и диагностику:
 * второй перечень разошёлся бы с первым на первом же добавлении.
 */
export const EVA_PROJECT_SKILLS = [
  "act",
  "audio-transcripts",
  "behavioral-activation",
  "cbt",
  "crisis-response",
  "emotion-regulation",
  "goals-values",
  "initiative",
  "journaling-reflection",
  "long-arc",
  "memory-hygiene",
  "motivational-interviewing",
  "osint-research",
  "relationships-boundaries",
  "schema-therapy",
  "subscription-status",
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
  /** Строк в SKILL.md: столько модель читает при каждом открытии навыка. */
  lines: number;
  /** Справочные материалы (`references/`): читаются по ссылке из SKILL.md, когда нужны. */
  references: string[];
  /** Заготовки (`templates/`): формы ответа и структуры, которые навык предлагает заполнить. */
  templates: string[];
}

/**
 * Структура навыка:
 *
 *   skills/<навык>/
 *   ├── SKILL.md      — коротко: когда открывать, что делать, границы
 *   ├── references/   — большие материалы, читаются по ссылке при нужде
 *   └── templates/    — заготовки ответа
 *
 * SKILL.md читается целиком при каждом открытии навыка, поэтому
 * держится коротким, а объёмное уходит в `references/`. Каждый файл
 * справки и заготовки упомянут в SKILL.md: неупомянутый модель не
 * найдёт. Исполняемого в навыке нет — ни каталога `scripts/`, ни
 * встроенных команд оболочки (`!`команда``, как в навыках Hermes):
 * навык — текст, а не программа.
 */
export const MAX_SKILL_LINES = 200;
const SKILL_SUBDIRECTORIES = new Set(["references", "templates"]);
const INLINE_SHELL = /!`[^`\n]+`/u;
const MATERIAL_LINK = /\b(references|templates)\/([A-Za-z0-9._-]+)/gu;

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
  /**
   * Сколько навыков Evaself ожидает.
   *
   * Отдаётся наружу, чтобы знаменатель «нашли N из M» не пришлось писать
   * второй раз рядом с потребителем. Ровно так `doctor.sh` и разошёлся с
   * кодом: в нём стояло рукописное 12, когда навыков стало тринадцать, и
   * здоровая установка печатала «13/12» — вид отказа там, где его нет.
   */
  expected: number;
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
    const structure = await readSkillStructure(join(root, directory), body);
    for (const reason of structure.problems) problems.push({ skill: directory, reason });
    skills.push({
      name, directory, descriptionLength: description.length,
      lines: body.split("\n").length, references: structure.references, templates: structure.templates,
    });
  }
  return { available: true, skills, problems };
}

async function listFiles(directory: string): Promise<string[] | null> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }
}

async function readSkillStructure(directory: string, body: string): Promise<{
  references: string[];
  templates: string[];
  problems: string[];
}> {
  const problems: string[] = [];
  const lines = body.split("\n").length;
  if (lines > MAX_SKILL_LINES) {
    problems.push(`SKILL.md длиннее ${MAX_SKILL_LINES} строк (${lines}): большие материалы — в references/`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "SKILL.md") continue;
    if (entry.isDirectory() && SKILL_SUBDIRECTORIES.has(entry.name)) continue;
    problems.push(entry.name === "scripts"
      ? "каталог scripts/ запрещён: навык не исполняет код"
      : `лишнее в каталоге навыка: ${entry.name} (разрешены references/ и templates/)`);
  }
  const references = await listFiles(join(directory, "references")) ?? [];
  const templates = await listFiles(join(directory, "templates")) ?? [];
  const texts = [body];
  for (const file of references) texts.push(await readFile(join(directory, "references", file), "utf8"));
  for (const file of templates) texts.push(await readFile(join(directory, "templates", file), "utf8"));
  if (texts.some((text) => INLINE_SHELL.test(text))) {
    problems.push("встроенная команда оболочки (!`…`) запрещена: навык не исполняет код");
  }
  const mentioned = new Set([...body.matchAll(MATERIAL_LINK)].map((match) => `${match[1]}/${match[2]}`));
  const present = new Set([...references.map((file) => `references/${file}`), ...templates.map((file) => `templates/${file}`)]);
  for (const link of mentioned) if (!present.has(link)) problems.push(`битая ссылка: ${link}`);
  for (const file of present) if (!mentioned.has(file)) problems.push(`не упомянут в SKILL.md: ${file}`);
  return { references, templates, problems };
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
    expected: EVA_PROJECT_SKILLS.length,
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
