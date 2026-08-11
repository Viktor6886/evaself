/**
 * Что считается допустимым содержимым версии артефакта.
 *
 * Схема этого знать не может: она видит `jsonb` и не отличает промпт от
 * сценария. Поэтому форма проверяется здесь — до записи, а не при чтении.
 * Версия с непроверенным содержимым не должна попадать в реестр вовсе:
 * реестр обещает воспроизводимость, а воспроизвести мусор нельзя.
 *
 * Шаблон memory block проверяется строже прочих: набор из шести блоков не
 * расширяется (инвариант 28), и шаблон — самый удобный способ протащить
 * седьмой блок незаметно. Здесь этот путь закрыт.
 */

import { createHash } from "node:crypto";

import { badRequest } from "../errors.js";
import { SYNCED_BLOCK_LABELS } from "../letta/memory-block-sync.js";

export const ARTIFACT_KINDS = [
  "prompt",
  "flow",
  "skill",
  "policy",
  "memory_block_template",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/** Верхняя граница содержимого версии. Реестр — не файловое хранилище. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Отпечаток содержимого.
 *
 * Ключи сортируются: `{"a":1,"b":2}` и `{"b":2,"a":1}` — одно и то же
 * содержимое, и разные отпечатки у них означали бы, что реестр считает
 * порядок ключей изменением артефакта.
 */
export function artifactChecksum(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex").slice(0, 32);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export interface ValidationReport {
  ok: boolean;
  /** Что именно проверено. Попадает в `artifact_versions.validation`. */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * Проверить содержимое версии.
 *
 * Бросает `bad_request` при отказе: непрошедшая проверку версия не
 * создаётся. Отчёт возвращается и при успехе — он хранится вместе с
 * версией, чтобы через полгода было видно, что именно проверяли.
 */
export function validateArtifactBody(kind: ArtifactKind, body: unknown): ValidationReport {
  const checks: ValidationReport["checks"] = [];
  const fail = (name: string, detail: string): never => {
    checks.push({ name, ok: false, detail });
    throw badRequest(`Версия артефакта не прошла проверку «${name}»: ${detail}`, { checks });
  };

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    fail("shape", "содержимое версии — объект, а не массив и не скаляр");
  }
  const size = Buffer.byteLength(canonicalJson(body), "utf8");
  if (size > MAX_BODY_BYTES) {
    fail("size", `${size} байт при пределе ${MAX_BODY_BYTES}`);
  }
  checks.push({ name: "size", ok: true, detail: `${size} байт` });

  const record = body as Record<string, unknown>;
  switch (kind) {
    case "prompt": {
      const text = record.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        fail("prompt.text", "нужна непустая строка `text`");
      }
      checks.push({ name: "prompt.text", ok: true, detail: `${(text as string).length} знаков` });
      break;
    }
    case "flow": {
      const steps = record.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        fail("flow.steps", "нужен непустой массив `steps`");
      }
      for (const [index, step] of (steps as unknown[]).entries()) {
        const named = step as { name?: unknown };
        if (!step || typeof step !== "object" || typeof named.name !== "string" || !named.name) {
          fail("flow.steps", `шаг ${index} без имени`);
        }
      }
      checks.push({ name: "flow.steps", ok: true, detail: `${(steps as unknown[]).length} шагов` });
      break;
    }
    case "skill": {
      if (typeof record.name !== "string" || !record.name) fail("skill.name", "нужна строка `name`");
      if (typeof record.source !== "string" || !record.source) {
        fail("skill.source", "нужна строка `source`");
      }
      checks.push({ name: "skill.name", ok: true });
      break;
    }
    case "policy": {
      const rules = record.rules;
      if (!Array.isArray(rules) || rules.length === 0) {
        fail("policy.rules", "нужен непустой массив `rules`");
      }
      checks.push({ name: "policy.rules", ok: true, detail: `${(rules as unknown[]).length} правил` });
      break;
    }
    case "memory_block_template": {
      const blocks = record.blocks;
      if (!Array.isArray(blocks) || blocks.length === 0) {
        fail("template.blocks", "нужен непустой массив `blocks`");
      }
      const seen = new Set<string>();
      for (const [index, block] of (blocks as unknown[]).entries()) {
        const entry = block as { label?: unknown; value?: unknown; limit?: unknown };
        if (typeof entry.label !== "string") fail("template.blocks", `блок ${index} без метки`);
        // Набор из шести блоков не расширяется. Шаблон — самый тихий способ
        // протащить седьмой, поэтому проверка стоит именно здесь.
        if (!(SYNCED_BLOCK_LABELS as readonly string[]).includes(entry.label as string)) {
          fail(
            "template.blocks",
            `метка «${entry.label}» вне закрытого набора из шести блоков`,
          );
        }
        if (seen.has(entry.label as string)) {
          fail("template.blocks", `метка «${entry.label}» повторяется`);
        }
        seen.add(entry.label as string);
        if (typeof entry.value !== "string") {
          fail("template.blocks", `блок «${entry.label}» без строкового значения`);
        }
        if (entry.limit !== undefined && (typeof entry.limit !== "number" || entry.limit <= 0)) {
          fail("template.blocks", `у блока «${entry.label}» неверный предел`);
        }
      }
      checks.push({
        name: "template.blocks",
        ok: true,
        detail: `${seen.size} из ${SYNCED_BLOCK_LABELS.length} блоков`,
      });
      break;
    }
  }

  return { ok: true, checks };
}

export interface ArtifactDiffEntry {
  path: string;
  change: "added" | "removed" | "changed";
  /** Длины, а не значения: содержимое промптов и блоков — не для журнала. */
  fromLength: number | null;
  toLength: number | null;
}

/**
 * Семантический diff двух версий.
 *
 * Сравниваются пути и размеры, а не тексты. Diff показывается человеку в
 * административном интерфейсе, и подставлять туда содержимое памяти или
 * системного промпта нельзя — ни то, ни другое пользователю не
 * раскрывается. Что именно изменилось по существу, видно из путей.
 */
export function diffArtifactBodies(from: unknown, to: unknown): ArtifactDiffEntry[] {
  const entries: ArtifactDiffEntry[] = [];
  walk("", from, to, entries);
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function walk(path: string, from: unknown, to: unknown, out: ArtifactDiffEntry[]): void {
  const bothObjects =
    from !== null && to !== null &&
    typeof from === "object" && typeof to === "object" &&
    !Array.isArray(from) && !Array.isArray(to);

  if (bothObjects) {
    const keys = new Set([
      ...Object.keys(from as Record<string, unknown>),
      ...Object.keys(to as Record<string, unknown>),
    ]);
    for (const key of keys) {
      const next = path ? `${path}.${key}` : key;
      walk(next, (from as Record<string, unknown>)[key], (to as Record<string, unknown>)[key], out);
    }
    return;
  }

  const same = canonicalJson(from) === canonicalJson(to);
  if (same) return;
  out.push({
    path: path || ".",
    change: from === undefined ? "added" : to === undefined ? "removed" : "changed",
    fromLength: from === undefined ? null : canonicalJson(from).length,
    toLength: to === undefined ? null : canonicalJson(to).length,
  });
}
