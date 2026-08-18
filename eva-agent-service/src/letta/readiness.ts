/**
 * Готовность Евы к работе, а не доступность App Server.
 *
 * Liveness и readiness — разные вопросы. «App Server отвечает» значит
 * только, что процесс жив: с выключенным MemFS, потерянным каталогом
 * навыков или урезанным набором инструментов он отвечает ровно так же,
 * а Ева при этом не помнит, не открывает навыки и не зовёт продуктовые
 * инструменты. Поэтому готовность проверяется по фактам, которые
 * runtime сообщил о себе сам.
 *
 * Здесь только вычисление. Сбор фактов — в `letta.ts`: он платный и
 * потому делается на открытии сессии и по расписанию, а не на каждом
 * ходу.
 */

/** Что runtime сообщил о себе. Ничего не додумано. */
export interface ObservedRuntime {
  /** Список инструментов, названный самим runtime. */
  tools: string[] | null;
  /**
   * Клиентские инструменты, фактически переданные открытой сессии.
   * Отдельно от `tools`: серверный список их не всегда называет, а
   * выполняются они в процессе SDK.
   */
  clientTools: string[];
  /**
   * Рабочая копия памяти агента на исполняющем устройстве. Не пустая
   * строка — MemFS действительно включён.
   */
  memoryDirectory: string | null;
  /** Устройство на связи: сессия и conversation работают. */
  isOnline: boolean | null;
  /** Режим разрешений, фактически применённый к сессии. */
  permissionMode: string | null;
  /** Рефлексия, как её сообщил runtime. `null` — не сообщил вовсе. */
  dreaming: { trigger: string } | null;
  /** Источники навыков, если транспорт их называет. */
  skillSources: string[] | null;
  /** Модель, на которой работает сессия. */
  model: string | null;
  observedAt: string | null;
}

export interface ReadinessExpectation {
  /** Продуктовые инструменты Evaself, которые обязаны быть доступны. */
  productTools: string[];
  /** Ожидаемый триггер рефлексии из настроек SDK. */
  dreamingTrigger: string | null;
  /** Ожидаемый режим разрешений. */
  permissionMode: string;
  /**
   * Сколько моделей в каталоге App Server: `null` — App Server не
   * ответил, `-1` — провайдер каталога не отдаёт, и проверить его
   * нечем.
   */
  modelCatalogSize: number | null;
}

export type CheckStatus = "ok" | "failed" | "not_reported";

/**
 * Состояние готовности одним словом.
 *
 * `ready` — всё подтверждено фактами. `degraded` — отказов нет, но
 * что-то не подтверждено: возможность ненаблюдаема этой версией SDK
 * либо снимок фактов устарел. `not_ready` — отказ ключевой возможности.
 *
 * Разделение нужно, потому что «не подтверждено» и «сломано» требуют
 * разных действий: первое — повод посмотреть, второе — не пускать
 * трафик.
 */
export type ReadinessState = "ready" | "degraded" | "not_ready";

/**
 * Сколько живёт снимок фактов.
 *
 * Факты снимаются при открытии сессии. После перезапуска App Server или
 * смены провайдера прежний снимок описывает уже не тот runtime, и
 * считать его бессрочным доказательством готовности нельзя. Пятнадцать
 * минут — заметно больше обычного простоя между ходами и заметно меньше
 * времени, за которое стенд успевает смениться незаметно.
 */
export const FACTS_STALE_AFTER_MS = 15 * 60_000;

export interface ReadinessCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface ReadinessReport {
  /** Пускать ли трафик: отказов нет. `degraded` тоже готов. */
  ready: boolean;
  state: ReadinessState;
  checks: ReadinessCheck[];
  observedAt: string | null;
  /** Возраст снимка фактов в секундах. `null` — фактов ещё нет. */
  observedAgeSeconds: number | null;
  /** Снимок старше срока: готовность подтверждена не сейчас. */
  stale: boolean;
}

/**
 * Имена инструментов проверяются точно.
 *
 * Расплывчатое `task|agent|subagent` совпадает с `update_task`,
 * `get_agent_state` и десятком продуктовых имён — такая проверка
 * зелёная всегда и не значит ничего. Память при этом опознаётся по
 * префиксу намеренно: её состав зависит от toolset и модели, и
 * закреплять одно имя значило бы объявить неготовность на следующей
 * версии harness.
 */
const MEMORY_TOOL = /^(memory|memfs)/i;
const SKILL_TOOLS = ["Skill"];
const SUBAGENT_TOOLS = ["Task", "TaskCreate", "TaskOutput"];

function check(name: string, status: CheckStatus, detail: string): ReadinessCheck {
  return { name, status, detail };
}

export function evaluateReadiness(
  observed: ObservedRuntime,
  expected: ReadinessExpectation,
  options: { now?: Date; staleAfterMs?: number } = {},
): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const tools = observed.tools;

  if (!tools || tools.length === 0) {
    checks.push(check("runtime_facts", "failed", "runtime ещё не назвал ни одного инструмента"));
  } else {
    checks.push(check("runtime_facts", "ok", `инструментов: ${tools.length}`));
  }

  const has = (name: string) => (tools ?? []).includes(name);
  const memory = (tools ?? []).filter((name) => MEMORY_TOOL.test(name));
  checks.push(memory.length > 0
    ? check("native_memory", "ok", memory.join(", "))
    : check("native_memory", "failed", "нативных инструментов памяти нет в наборе сессии"));

  const skills = SKILL_TOOLS.filter(has);
  checks.push(skills.length > 0
    ? check("native_skills", "ok", skills.join(", "))
    : check("native_skills", "failed", `нет инструмента ${SKILL_TOOLS.join(" или ")}`));

  const subagents = SUBAGENT_TOOLS.filter(has);
  checks.push(subagents.length > 0
    ? check("native_subagents", "ok", subagents.join(", "))
    : check("native_subagents", "failed", `нет инструмента ${SUBAGENT_TOOLS.join(" или ")}`));

  // Продуктовый инструмент доступен, если его назвал runtime либо он
  // передан живой сессии: и то и другое — факт о сессии, а не о
  // конфигурации.
  const available = new Set([...(tools ?? []), ...observed.clientTools]);
  const missingProduct = expected.productTools.filter((name) => !available.has(name));
  checks.push(missingProduct.length === 0 && expected.productTools.length > 0
    ? check(
        "product_tools",
        "ok",
        observed.clientTools.length > 0
          ? `переданы сессии: ${observed.clientTools.length}`
          : expected.productTools.join(", "),
      )
    : check(
        "product_tools",
        "failed",
        expected.productTools.length === 0
          ? "продуктовые инструменты не объявлены"
          : `недоступны: ${missingProduct.join(", ")}`,
      ));

  checks.push(observed.memoryDirectory
    ? check("memfs", "ok", observed.memoryDirectory)
    : check("memfs", "failed", "runtime не сообщил рабочий каталог памяти агента"));

  checks.push(observed.isOnline === true
    ? check("session", "ok", "устройство на связи, conversation работает")
    : check("session", "failed", observed.isOnline === false
      ? "устройство не на связи"
      : "состояние сессии не наблюдалось"));

  checks.push(observed.model
    ? check("model", "ok", observed.model)
    : check("model", "failed", "сессия не назвала модель"));

  checks.push(expected.modelCatalogSize === null
    ? check("model_catalog", "failed", "App Server не ответил")
    : expected.modelCatalogSize < 0
      ? check("model_catalog", "not_reported", "провайдер не отдаёт каталог моделей")
      : expected.modelCatalogSize > 0
        ? check("model_catalog", "ok", `моделей в каталоге: ${expected.modelCatalogSize}`)
        : check("model_catalog", "failed", "App Server не предлагает ни одной модели"));

  // Режим разрешений: расхождение с настройкой значит, что сессия
  // работает не в том режиме, который человек выбрал.
  checks.push(observed.permissionMode === null
    ? check("permission_mode", "not_reported", "runtime не сообщил режим разрешений")
    : observed.permissionMode === expected.permissionMode
      ? check("permission_mode", "ok", observed.permissionMode)
      : check("permission_mode", "failed",
        `ожидался ${expected.permissionMode}, применён ${observed.permissionMode}`));

  // Рефлексию установленная версия SDK в init не приносит. Не сообщил —
  // так и написано: выдавать ненаблюдаемое за проверенное нельзя.
  // Сообщил и разошёлся с настройкой — это отказ.
  checks.push(observed.dreaming === null
    ? check("dreaming", "not_reported", "runtime не сообщает настройки рефлексии")
    : expected.dreamingTrigger === null || observed.dreaming.trigger === expected.dreamingTrigger
      ? check("dreaming", "ok", observed.dreaming.trigger)
      : check("dreaming", "failed",
        `ожидался триггер ${expected.dreamingTrigger}, применён ${observed.dreaming.trigger}`));

  checks.push(observed.skillSources === null
    ? check("skill_sources", "not_reported", "транспорт не называет источники навыков")
    : observed.skillSources.length > 0
      ? check("skill_sources", "ok", observed.skillSources.join(", "))
      : check("skill_sources", "failed", "источники навыков пусты — навыки не обнаружены"));

  // Свежесть снимка — такой же факт, как и остальные. Устаревший снимок
  // не объявляется отказом: сессия могла просто долго не открываться. Но
  // и доказательством готовности он больше не считается.
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? FACTS_STALE_AFTER_MS;
  const observedMs = observed.observedAt ? Date.parse(observed.observedAt) : Number.NaN;
  const ageSeconds = Number.isFinite(observedMs)
    ? Math.max(0, Math.round((now.getTime() - observedMs) / 1000))
    : null;
  const stale = ageSeconds !== null && ageSeconds * 1000 > staleAfterMs;
  checks.push(ageSeconds === null
    ? check("facts_fresh", "failed", "фактов о runtime ещё нет")
    : stale
      ? check("facts_fresh", "not_reported", `снимок фактов старше ${Math.round(staleAfterMs / 60_000)} мин: ${ageSeconds} с`)
      : check("facts_fresh", "ok", `снимку фактов ${ageSeconds} с`));

  const failed = checks.some((entry) => entry.status === "failed");
  const unconfirmed = checks.some((entry) => entry.status === "not_reported");
  return {
    // Отсутствие ключевой возможности — это неготовность, без запасных
    // путей и снисхождения. Ненаблюдаемое (`not_reported`) готовность не
    // отменяет: его нельзя ни подтвердить, ни опровергнуть, — но и за
    // подтверждённое оно не выдаётся: об этом говорит `degraded`.
    ready: !failed,
    state: failed ? "not_ready" : unconfirmed ? "degraded" : "ready",
    checks,
    observedAt: observed.observedAt,
    observedAgeSeconds: ageSeconds,
    stale,
  };
}
