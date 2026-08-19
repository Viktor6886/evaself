/**
 * Самопроверка рантайма: что Ева фактически наблюдает о себе.
 *
 * Второго диагностического обхода здесь нет. Все факты уже собраны
 * другими путями — снимок сессии SDK, сверка блоков, каталог навыков,
 * счётчик вызовов инструментов, — а этот модуль их только складывает в
 * один ответ. Ни один факт не добывается «своим» способом.
 *
 * Разница между «наблюдаю» и «не могу подтвердить» сохраняется по всему
 * отчёту: `null` означает, что runtime этого не сообщил, и это не то же
 * самое, что «нет». Иначе Ева на вопрос о себе отвечала бы догадкой,
 * ровно как раньше отвечала самоотчётом.
 *
 * Ни содержимого блоков, ни текста навыков, ни рассуждений здесь не
 * появляется — только метки, имена, длины и счётчики.
 */

import { SYNCED_BLOCK_LABELS } from "./memory-blocks.js";
import type { LegacyBlockRecord } from "./persona-sync.js";
import { auditSkills, type SkillsAuditResult } from "./skills-audit.js";

export interface RuntimeFactsLike {
  memfsEnabled: boolean | null;
  skillSources: string[] | null;
  tools: string[] | null;
  observedAt: string;
}

export interface SessionFactsLike {
  tools: string[] | null;
  memoryDirectory: string | null;
  observedAt: string;
}

export interface MemoryObservation {
  /** Метки канонических блоков, которые сверка видела у агента. */
  canonicalPresent: string[];
  legacy: LegacyBlockRecord[];
  /** Сверка вообще выполнялась. Без неё состав блоков — не наблюдение. */
  checked: boolean;
}

export interface RuntimeInspection {
  /**
   * Что зарегистрировано в этой сессии из телеграмных умений.
   *
   * `null` — состав инструментов сессии не наблюдается, а не «умения
   * нет»: разница здесь та же, что и во всём остальном отчёте.
   */
  telegram: {
    reactions: boolean | null;
    buttons: boolean | null;
    polls: boolean | null;
  };
  memory: {
    canonical: string[];
    present: string[] | null;
    missing: string[] | null;
    legacy: Array<{ label: string; status: string; size: number }>;
    complete: boolean | null;
  };
  memfs: {
    enabled: boolean | null;
    /** Каталог памяти есть. Сам путь наружу не отдаётся. */
    directoryPresent: boolean | null;
  };
  skills: SkillsAuditResult;
  calls: {
    skillCalls: number;
    last: { skillName: string | null; at: string; succeeded: boolean | null } | null;
  };
  observedAt: string | null;
}

export interface InspectionInput {
  runtime: RuntimeFactsLike | null;
  session: SessionFactsLike | null;
  memory: MemoryObservation | null;
  skillsRoot: string;
  calls: {
    skillCalls: number;
    last: { skillName: string | null; at: string; succeeded: boolean | null } | null;
  };
}

export async function inspectRuntime(input: InspectionInput): Promise<RuntimeInspection> {
  const canonical = [...SYNCED_BLOCK_LABELS];
  const present = input.memory?.checked ? input.memory.canonicalPresent : null;
  const skills = await auditSkills({
    root: input.skillsRoot,
    sources: input.runtime?.skillSources ?? null,
    // Состав инструментов сессии точнее: он назван самим сеансом, а не
    // снимком при открытии. Если сессии нет — берём снимок.
    sessionTools: input.session?.tools ?? input.runtime?.tools ?? null,
  });

  // Что Ева умеет в Telegram — это факт состава сессии, а не
  // впечатление. Ответ «я не умею ставить кнопки» при
  // зарегистрированном инструменте — такая же выдумка, как рассказ про
  // собственную память: у человека он выглядит как отказ, хотя отказа
  // нет. `null` означает «состав сессии не наблюдаю».
  const tools = input.session?.tools ?? input.runtime?.tools ?? null;
  const registered = (name: string): boolean | null =>
    tools === null ? null : tools.includes(name);

  return {
    telegram: {
      reactions: registered("set_reaction"),
      buttons: registered("present_inline_choices"),
      polls: registered("send_poll"),
    },
    memory: {
      canonical,
      present,
      missing: present ? canonical.filter((label) => !present.includes(label)) : null,
      legacy: (input.memory?.legacy ?? []).map((block) => ({
        label: block.label, status: block.status, size: block.size,
      })),
      complete: present ? canonical.every((label) => present.includes(label)) : null,
    },
    memfs: {
      enabled: input.runtime?.memfsEnabled ?? null,
      directoryPresent: input.session
        ? Boolean(input.session.memoryDirectory)
        : null,
    },
    skills,
    calls: input.calls,
    observedAt: input.session?.observedAt ?? input.runtime?.observedAt ?? null,
  };
}
