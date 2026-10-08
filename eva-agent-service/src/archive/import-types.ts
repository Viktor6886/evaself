/**
 * Записи, в которые разбирается присланный архив (`import-parse.ts`), и
 * отчёт об ошибках строк. Отдельным модулем: их читают и разбор, и запись
 * в базу (`import-apply.ts`), а сами по себе они — контракт между ними.
 */

import type { LABELS, SheetId } from "./sheets.js";

export interface RowError {
  sheet: string;
  /** Номер строки так, как его показывает Excel (заголовок — первая). */
  row: number;
  message: string;
}

export interface Parsed<T> {
  row: number;
  value: T;
}

export interface ProfileImport {
  first_name?: string;
  last_name?: string;
  timezone?: string;
  city?: string;
  country_code?: string;
  response_mode?: keyof typeof LABELS.responseMode;
  agent_mode?: keyof typeof LABELS.agentMode;
  use_emoji?: boolean;
  heartbeat_enabled?: boolean;
}

export interface QuestionnaireImport {
  field_key: string;
  value: string;
  status: "candidate" | "confirmed";
}

export interface NorthImport {
  desired_direction: string | null;
  why_it_matters: string | null;
  values: unknown;
  conflicts: unknown;
  reduce_list: unknown;
  acceptable_cost: string | null;
  unacceptable_cost: string | null;
  user_confirmed: boolean;
}

export interface GoalImport {
  ref: string | null;
  parent: string | null;
  title: string;
  life_area: string | null;
  horizon: string | null;
  why_it_matters: string | null;
  result_artifact: string | null;
  target_date: string | null;
  success_criteria: unknown;
  minimum_version: string | null;
  target_version: string | null;
  constraints: unknown;
  learning_goal: string | null;
  review_condition: string | null;
  stop_condition: string | null;
  priority: number;
  status: keyof typeof LABELS.goalStatus;
  vector_stage: keyof typeof LABELS.goalStage;
  user_confirmed: boolean;
  created_at: string | null;
  completed_at: string | null;
}

export interface ResultImport {
  ref: string | null;
  goal: string;
  parent: string | null;
  title: string;
  result_artifact: string | null;
  success_criteria: unknown;
  minimum_version: string | null;
  target_date: string | null;
  sort_order: number;
  status: keyof typeof LABELS.resultStatus;
  is_checkpoint: boolean;
  is_external: boolean;
  external_dependency: string | null;
  is_critical_path: boolean;
  fallback_plan: string | null;
  first_action: string | null;
  progress_percent: number;
  completed_at: string | null;
}

export interface TaskImport {
  title: string;
  description: string | null;
  kind: keyof typeof LABELS.taskKind;
  status: keyof typeof LABELS.taskStatus;
  priority: number;
  due_at: string | null;
  remind_at: string | null;
  cron_expression: string | null;
  repeat_enabled: boolean;
  timezone: string | null;
  reminders_enabled: boolean;
  goal: string | null;
  result: string | null;
  estimated_minutes: number | null;
  energy_required: number | null;
  created_at: string | null;
  completed_at: string | null;
}

export interface JournalImport {
  local_date: string;
  title: string | null;
  content: string;
  mood: keyof typeof LABELS.mood | null;
  energy: number | null;
  people: string[];
  created_at: string | null;
}

export interface PersonImport {
  display_name: string;
  relation: string | null;
}

export interface NoteImport {
  title: string;
  content: string;
  category: string | null;
  tags: string[];
  pinned: boolean;
  entry_type: keyof typeof LABELS.noteType;
  created_at: string | null;
}

export interface CheckinImport {
  local_date: string;
  mood: keyof typeof LABELS.mood;
  energy: number;
  tension: number;
  note: string | null;
}

export interface BudgetImport {
  occurred_on: string;
  entry_type: keyof typeof LABELS.budgetType;
  amount_minor: number;
  currency: string;
  category: string | null;
  store: string | null;
  description: string | null;
  payment_method: string | null;
  quantity: number | null;
}

export interface DecisionImport {
  question: string;
  options: string[];
  facts: string[];
  assumptions: string[];
  criteria: string[];
  risks: string[];
  selected_option: string | null;
  confidence: number | null;
  reversible: boolean | null;
  cheap_test: string | null;
  review_at: string | null;
  actual_result: string | null;
  status: keyof typeof LABELS.decisionStatus;
  created_at: string | null;
}

export interface ParsedArchive {
  /** Лист «О файле» с форматом архива Евы. */
  recognized: boolean;
  /** Пояс стенных часов в файле: из «О файле», иначе пояс человека. */
  zone: string;
  sheetsFound: SheetId[];
  readOnlySheets: string[];
  profile: ProfileImport | null;
  questionnaire: Array<Parsed<QuestionnaireImport>>;
  north: NorthImport | null;
  goals: Array<Parsed<GoalImport>>;
  results: Array<Parsed<ResultImport>>;
  tasks: Array<Parsed<TaskImport>>;
  journal: Array<Parsed<JournalImport>>;
  people: Array<Parsed<PersonImport>>;
  notes: Array<Parsed<NoteImport>>;
  checkins: Array<Parsed<CheckinImport>>;
  budget: Array<Parsed<BudgetImport>>;
  decisions: Array<Parsed<DecisionImport>>;
  /** Память Евы из файла: в память не пишется, только передаётся человеку. */
  memory: Array<{ label: string; value: string }>;
  errors: RowError[];
  warnings: string[];
}

/** Отказ всему файлу: читать его дальше бессмысленно. */
export class ArchiveRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveRejected";
  }
}
