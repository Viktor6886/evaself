import type { Database } from "../db.js";

/**
 * Курсор длинной guided-программы.
 *
 * Это не память агента и не второй когнитивный контур. Модель не решает
 * здесь, что вспомнить и какой навык открыть: она сообщает, на каком шаге
 * методики остановилась работа, а запись делает серверный код с проверкой
 * владельца и оптимистической блокировкой.
 *
 * Психологическая непрерывность сюда не попадает. У неё есть штатное
 * место — `current_state`, MemFS и recall Letta, — и дублировать его
 * продуктовой таблицей значило бы завести вторую память.
 */

export type GoalProgramAction =
  | "start"
  | "advance"
  | "pause"
  | "resume"
  | "complete"
  | "cancel";

export type GoalProgramStatus = "active" | "paused" | "completed" | "cancelled";

export type GoalProgramResumePolicy = "contextual" | "on_request" | "scheduled";

const ACTIONS = new Set<string>([
  "start", "advance", "pause", "resume", "complete", "cancel",
]);
const RESUME_POLICIES = new Set<string>(["contextual", "on_request", "scheduled"]);

/** Длины совпадают с CHECK-ограничениями миграции 065. */
const KEY_LIMIT = 100;
const HINT_LIMIT = 300;

export interface GoalProgramRun {
  id: number;
  user_id: number;
  program_key: string;
  program_version: number;
  primary_goal_id: number | null;
  status: GoalProgramStatus;
  phase_key: string | null;
  step_key: string | null;
  last_completed_step_key: string | null;
  next_step_key: string | null;
  next_action_hint: string | null;
  resume_policy: GoalProgramResumePolicy;
  revision: number;
  started_at: string;
  last_progress_at: string;
  completed_at: string | null;
}

export interface UpdateGoalProgramInput {
  userId: number;
  action: GoalProgramAction;
  programKey: string;
  programVersion?: number;
  primaryGoalId?: number | null;
  phaseKey?: string | null;
  stepKey?: string | null;
  lastCompletedStepKey?: string | null;
  nextStepKey?: string | null;
  nextActionHint?: string | null;
  resumePolicy?: GoalProgramResumePolicy;
  /**
   * Ревизия, которую видела модель. Курсор переживает перезапуск и новый
   * conversation, поэтому «продолжим» может прийти из хода, открытого до
   * чужого обновления. Несовпадение — это не ошибка человека, а повод
   * перечитать состояние, а не затирать чужой шаг.
   */
  expectedRevision?: number;
}

export interface UpdateGoalProgramResult {
  run: GoalProgramRun;
  /** `false` — повтор того же шага: состояние уже такое, ревизия не растёт. */
  applied: boolean;
}

export class GoalProgramService {
  // Сброс кэша продуктового контекста делает общий слой инструментов по
  // `CONTEXT_MUTATING_TOOLS`: заводить здесь второй путь инвалидации
  // значит держать два места, которые обязаны совпадать.
  constructor(private readonly db: Database) {}

  /**
   * Что у человека с guided-программами.
   *
   * Отдаётся курсор и ничего сверх него: истории шагов, стенограммы и
   * целей VECTOR здесь нет — за ними идут `get_goal_context` и recall.
   */
  async getContext(
    userId: number,
    programKey?: string,
  ): Promise<{
    active: GoalProgramRun | null;
    runs: GoalProgramRun[];
  }> {
    const { rows } = await this.db.query<GoalProgramRun>(
      `SELECT id, user_id, program_key, program_version, primary_goal_id, status,
              phase_key, step_key, last_completed_step_key, next_step_key,
              next_action_hint, resume_policy, revision,
              started_at, last_progress_at, completed_at
         FROM goal_program_runs
        WHERE user_id = $1
          AND ($2::text IS NULL OR program_key = $2)
        ORDER BY
          CASE status
            WHEN 'active' THEN 0
            WHEN 'paused' THEN 1
            ELSE 2
          END,
          last_progress_at DESC
        LIMIT 20`,
      [userId, cleanKey(programKey) ?? null],
    );
    const runs = rows.map(normalize);
    return { active: runs.find((run) => run.status === "active") ?? null, runs };
  }

  async update(input: UpdateGoalProgramInput): Promise<UpdateGoalProgramResult> {
    const action = input.action;
    if (!ACTIONS.has(action)) throw new Error(`Неизвестное действие программы: ${action}`);
    const programKey = cleanKey(input.programKey);
    if (!programKey) throw new Error("program_key: требуется непустой ключ методики");
    if (input.resumePolicy && !RESUME_POLICIES.has(input.resumePolicy)) {
      throw new Error(`Неизвестная политика возврата: ${input.resumePolicy}`);
    }
    if (input.primaryGoalId != null && input.primaryGoalId > 0) {
      await this.requireGoal(input.userId, input.primaryGoalId);
    }

    const open = await this.openRun(input.userId, programKey);

    if (action === "start") {
      // Повторный запуск незакрытой программы — ровно то поведение,
      // которое эта задача чинит: слабая модель начинает методику
      // сначала и теряет пройденные шаги. Открытый запуск возвращается
      // как есть, чтобы ход продолжился с сохранённого места.
      if (open) return { run: open, applied: false };
      return { run: await this.insert(input, programKey), applied: true };
    }

    if (!open) {
      throw new Error(
        `Открытой программы «${programKey}» нет: сначала запусти её действием start`,
      );
    }
    this.assertFresh(open, input.expectedRevision);
    return await this.applyToOpenRun(open, input, action);
  }

  private async applyToOpenRun(
    open: GoalProgramRun,
    input: UpdateGoalProgramInput,
    action: Exclude<GoalProgramAction, "start">,
  ): Promise<UpdateGoalProgramResult> {
    if (action === "resume" && open.status === "active") {
      return { run: open, applied: false };
    }
    if (action === "pause" && open.status === "paused") {
      return { run: open, applied: false };
    }

    const next = {
      status: statusAfter(action),
      phaseKey: pick(input.phaseKey, open.phase_key, KEY_LIMIT),
      stepKey: pick(input.stepKey, open.step_key, KEY_LIMIT),
      lastCompletedStepKey: pick(
        input.lastCompletedStepKey, open.last_completed_step_key, KEY_LIMIT,
      ),
      nextStepKey: pick(input.nextStepKey, open.next_step_key, KEY_LIMIT),
      nextActionHint: pick(input.nextActionHint, open.next_action_hint, HINT_LIMIT),
      resumePolicy: input.resumePolicy ?? open.resume_policy,
      primaryGoalId: input.primaryGoalId === undefined
        ? open.primary_goal_id
        : link(input.primaryGoalId),
    };

    // Повтор того же вызова после сбоя не должен двигать ревизию: иначе
    // следующий честный `expected_revision` отвергается, и модель уходит
    // перечитывать состояние, которое не менялось.
    const unchanged = next.status === open.status
      && next.phaseKey === open.phase_key
      && next.stepKey === open.step_key
      && next.lastCompletedStepKey === open.last_completed_step_key
      && next.nextStepKey === open.next_step_key
      && next.nextActionHint === open.next_action_hint
      && next.resumePolicy === open.resume_policy
      && next.primaryGoalId === open.primary_goal_id;
    if (unchanged) return { run: open, applied: false };

    const terminal = next.status === "completed" || next.status === "cancelled";
    const { rows } = await this.db.query<GoalProgramRun>(
      `UPDATE goal_program_runs
          SET status = $3,
              phase_key = $4,
              step_key = $5,
              last_completed_step_key = $6,
              next_step_key = $7,
              next_action_hint = $8,
              resume_policy = $9,
              primary_goal_id = $10,
              revision = revision + 1,
              last_progress_at = now(),
              completed_at = CASE WHEN $11::boolean THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND user_id = $2 AND revision = $12
        RETURNING id, user_id, program_key, program_version, primary_goal_id, status,
                  phase_key, step_key, last_completed_step_key, next_step_key,
                  next_action_hint, resume_policy, revision,
                  started_at, last_progress_at, completed_at`,
      [
        open.id, input.userId, next.status, next.phaseKey, next.stepKey,
        next.lastCompletedStepKey, next.nextStepKey, next.nextActionHint,
        next.resumePolicy, next.primaryGoalId, terminal, open.revision,
      ],
    );
    const updated = rows[0];
    // Условие по ревизии не выполнилось — значит между чтением и записью
    // прошёл чужой ход. Тихо перезаписывать его шаг нельзя.
    if (!updated) {
      throw new Error(
        "Состояние программы изменилось между чтением и записью: "
        + "перечитай его через get_goal_program_context",
      );
    }
    return { run: normalize(updated), applied: true };
  }

  private async insert(
    input: UpdateGoalProgramInput,
    programKey: string,
  ): Promise<GoalProgramRun> {
    const { rows } = await this.db.query<GoalProgramRun>(
      `INSERT INTO goal_program_runs (
         user_id, program_key, program_version, primary_goal_id, status,
         phase_key, step_key, last_completed_step_key, next_step_key,
         next_action_hint, resume_policy
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6, NULL, $7, $8, $9)
       RETURNING id, user_id, program_key, program_version, primary_goal_id, status,
                 phase_key, step_key, last_completed_step_key, next_step_key,
                 next_action_hint, resume_policy, revision,
                 started_at, last_progress_at, completed_at`,
      [
        input.userId,
        programKey,
        Math.max(1, Math.trunc(input.programVersion ?? 1)),
        link(input.primaryGoalId ?? null),
        clean(input.phaseKey, KEY_LIMIT),
        clean(input.stepKey, KEY_LIMIT),
        clean(input.nextStepKey, KEY_LIMIT),
        clean(input.nextActionHint, HINT_LIMIT),
        input.resumePolicy ?? "contextual",
      ],
    );
    const created = rows[0];
    if (!created) throw new Error("Программа не была создана");
    return normalize(created);
  }

  /** Незавершённый запуск методики — активный или поставленный на паузу. */
  private async openRun(
    userId: number,
    programKey: string,
  ): Promise<GoalProgramRun | null> {
    const { rows } = await this.db.query<GoalProgramRun>(
      `SELECT id, user_id, program_key, program_version, primary_goal_id, status,
              phase_key, step_key, last_completed_step_key, next_step_key,
              next_action_hint, resume_policy, revision,
              started_at, last_progress_at, completed_at
         FROM goal_program_runs
        WHERE user_id = $1
          AND program_key = $2
          AND status IN ('active', 'paused')
        LIMIT 1`,
      [userId, programKey],
    );
    const row = rows[0];
    return row ? normalize(row) : null;
  }

  private assertFresh(run: GoalProgramRun, expected?: number): void {
    if (expected === undefined || expected === null) return;
    if (!Number.isSafeInteger(expected) || expected !== run.revision) {
      throw new Error(
        `Состояние программы уже изменилось (ревизия ${run.revision}): `
        + "перечитай его через get_goal_program_context",
      );
    }
  }

  private async requireGoal(userId: number, goalId: number): Promise<void> {
    const { rows } = await this.db.query(
      "SELECT id FROM goals WHERE id = $1 AND user_id = $2",
      [goalId, userId],
    );
    if (rows.length === 0) throw new Error("Цель программы не найдена");
  }
}

function statusAfter(
  action: Exclude<GoalProgramAction, "start">,
): GoalProgramStatus {
  switch (action) {
    case "advance":
      // Продвижение по паузе само её снимает: человек вернулся к работе.
      return "active";
    case "pause":
      return "paused";
    case "resume":
      return "active";
    case "complete":
      return "completed";
    case "cancel":
      return "cancelled";
  }
}

function normalize(row: GoalProgramRun): GoalProgramRun {
  return {
    ...row,
    id: Number(row.id),
    user_id: Number(row.user_id),
    program_version: Number(row.program_version),
    revision: Number(row.revision),
    primary_goal_id: row.primary_goal_id == null ? null : Number(row.primary_goal_id),
  };
}

/** Ноль в необязательной связи означает «связи нет», а не запись номер ноль. */
function link(value: number | null | undefined): number | null {
  if (value == null) return null;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function clean(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanKey(value: string | null | undefined): string | null {
  return clean(value, KEY_LIMIT);
}

/** Не переданное поле сохраняет прежнее значение, явный `null` — стирает. */
function pick(
  incoming: string | null | undefined,
  current: string | null,
  max: number,
): string | null {
  return incoming === undefined ? current : clean(incoming, max);
}
