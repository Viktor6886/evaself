/**
 * Разделы подсистем, которых в репозитории ещё нет.
 *
 * Шаг 12 требует, чтобы область была доступна, и одновременно запрещает
 * реализовывать функциональность отсутствующей подсистемы. Между этими
 * требованиями нет противоречия: доступен раздел, который честно говорит,
 * чего нет, когда появится и что показывает вместо этого.
 *
 * Чего здесь нет намеренно:
 *
 *   пустых таблиц, выдающих себя за данные, — раздел не притворяется, что
 *     навыков ноль; он говорит, что каталога навыков не существует;
 *   кнопок без последствий — переиндексация, отмена исследования, запуск
 *     evals и kill switch расширения появляются вместе со своим механизмом,
 *     а не раньше;
 *   заглушек «скоро» без номера шага — «когда-нибудь» невозможно проверить.
 *
 * Проверка по инварианту 20 выполнена: эквивалента этому реестру статусов в
 * репозитории нет. Ближайшее — `docs/IMPLEMENTATION_STATUS.md`, но это
 * документ о возможностях SDK, а не ответ административного API.
 */

export interface SubsystemSection {
  /** Идентификатор раздела в административном API. */
  id: string;
  title: string;
  implemented: boolean;
  /** Шаг roadmap, который эту подсистему вводит. */
  plannedStep: string;
  /** Что существует сегодня и откуда это видно. */
  today: string;
  /** Что раздел покажет, когда подсистема появится. */
  willShow: string[];
}

export const SUBSYSTEM_SECTIONS: readonly SubsystemSection[] = [
  {
    id: "skills",
    title: "Навыки",
    implemented: true,
    plannedStep: "19 — ядро навыков, 20 — маршрутизатор навыков",
    today: "Ядро загружается штатным project source Letta из `.skills`; маршрутизируемые "
      + "версии синхронизируются с ArtifactRegistry в tenant-scoped PostgreSQL hybrid index. "
      + "Решения, sticky state, latency и вызовы reranker сохраняются без сырого текста.",
    willShow: [
      "каталог: имя, версия, статус, хэш содержимого",
      "ошибки индексации и статистика выбора",
      "включение, отключение, переиндексация",
      "тестовый прогон маршрутизации по запросу",
    ],
  },
  {
    id: "research",
    title: "Исследования",
    implemented: false,
    plannedStep: "24 — исследования",
    today: "Механизм фонового хода агента есть (`src/jobs/agent-job.ts`), но задания "
      + "исследования на нём нет: планы, источники, утверждения и бюджеты нигде не "
      + "хранятся. Назначение conversation `research` существует и ограничивает "
      + "инструменты, но самостоятельным исследованием не является.",
    willShow: [
      "планы исследований и их источники",
      "утверждения с указанием источника",
      "бюджеты, запуски и отмена",
    ],
  },
  {
    id: "evals",
    title: "Evals",
    implemented: false,
    plannedStep: "22 — evals и release gate",
    today: "Наборов, датасетов и прогонов нет. Реестр артефактов умеет хранить "
      + "результат тестов версии (`artifact_versions.test_result`) и фиксировать "
      + "версии прогона (`artifact_usages`, вид `eval`) — это подготовленное место, "
      + "а не работающая подсистема.",
    willShow: [
      "наборы и датасеты",
      "прогоны и оценки",
      "состояние release gate",
    ],
  },
  {
    id: "extensions",
    title: "Расширения",
    implemented: false,
    plannedStep: "32 — расширения",
    today: "Реестра расширений нет. Произвольный JavaScript из административной "
      + "панели и произвольные stdio-MCP запрещены инвариантами и останутся "
      + "запрещёнными после появления раздела.",
    willShow: [
      "реестр расширений и их версии",
      "запрошенные права",
      "kill switch отдельного расширения",
    ],
  },
];

export function subsystemSection(id: string): SubsystemSection | undefined {
  return SUBSYSTEM_SECTIONS.find((section) => section.id === id);
}

/** Ответ раздела: статус и пустые коллекции, названные своими именами. */
export function subsystemPayload(section: SubsystemSection): Record<string, unknown> {
  return {
    id: section.id,
    title: section.title,
    status: {
      implemented: section.implemented,
      planned_step: section.plannedStep,
      detail: section.today,
    },
    will_show: section.willShow,
    items: [],
  };
}
