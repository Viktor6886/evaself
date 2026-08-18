/**
 * Какой технической цепочкой провайдеров идёт запрос.
 *
 * Раньше здесь стоял классификатор: содержание сообщения разбиралось
 * регулярными выражениями («увольн», «развод», «отношени», «снова»,
 * «постоянно»), складывалось в балл, и по баллу выбиралась модель
 * `fast`, `chat` или `deep`; неоднозначные случаи уходили на отдельный
 * LLM-вызов. Это был второй когнитивный контур поверх Letta: он решал
 * за неё, насколько глубоко думать над сообщением, — при том что
 * глубину анализа, выбор навыка, обращение к памяти и субагента решает
 * сам runtime.
 *
 * Осталось решение о транспорте, а не о смысле. Ни одно правило здесь
 * не читает текст пользователя:
 *
 * 1. режим одной модели — техническая цепочка `single`;
 * 2. маршрут, названный вызывающим явно (`model: "eva/json"` или
 *    `metadata.route`), — это отдельная продуктовая операция;
 * 3. технические требования самого запроса: изображение — `vision`,
 *    строгий JSON — `json`;
 * 4. назначение conversation: планировщик, обслуживание, профиль,
 *    разбор целей, исследование — это не разговор;
 * 5. явно выбранный человеком баланс качества и стоимости;
 * 6. иначе — `chat`.
 */

import type { LlmRequest, RoutingSettings } from "./types.js";

export const EVA_ROUTES = [
  "chat", "deep", "fast", "research", "vision", "tools", "json", "single",
] as const;
export type EvaRoute = typeof EVA_ROUTES[number];

export interface RouteResolution {
  requestedRoute: string;
  effectiveRoute: EvaRoute;
  /** Почему выбран маршрут. Для телеметрии и разбора, не для модели. */
  source: "single_mode" | "requested" | "technical" | "purpose" | "preference" | "default";
  reasons: string[];
}

/** Назначение conversation → цепочка. Продуктовая операция, а не смысл сообщения. */
const PURPOSE_ROUTE: Readonly<Record<string, EvaRoute>> = Object.freeze({
  scheduler: "fast",
  profile: "json",
  goal_review: "deep",
  partner_analysis: "deep",
  research: "research",
});

/**
 * Явный выбор человека: инструмент `update_llm_quality_mode` меняет
 * `user_preferences.llm_quality_mode`. Это выбор стоимости и качества,
 * сделанный пользователем вслух, а не вывод о его сообщении.
 */
const PREFERENCE_ROUTE: Readonly<Record<string, EvaRoute>> = Object.freeze({
  economy: "fast",
  quality: "deep",
});

export function resolveRoute(request: LlmRequest, settings: RoutingSettings): RouteResolution {
  const requestedRoute = request.metadata.requested_route ?? request.metadata.route ?? "chat";

  if (settings.mode === "single") {
    return fixed(requestedRoute, "single", "single_mode", ["global_single_mode"]);
  }
  if (requestedRoute !== "chat" && isEvaRoute(requestedRoute)) {
    return fixed(requestedRoute, requestedRoute, "requested", ["caller_requested_route"]);
  }
  if (request.metadata.has_image) {
    return fixed(requestedRoute, "vision", "technical", ["image_in_request"]);
  }
  if (request.response_format?.type === "json_object") {
    return fixed(requestedRoute, "json", "technical", ["json_response_required"]);
  }

  const purpose = request.metadata.purpose ?? "chat";
  const purposeRoute = PURPOSE_ROUTE[purpose];
  if (purposeRoute) {
    return fixed(requestedRoute, purposeRoute, "purpose", [`purpose_${purpose}`]);
  }

  const preference = PREFERENCE_ROUTE[request.metadata.user_mode ?? "auto"];
  if (preference) {
    return fixed(requestedRoute, preference, "preference", [`user_mode_${request.metadata.user_mode}`]);
  }

  return fixed(requestedRoute, "chat", "default", []);
}

/**
 * Маршрут ровно такой, каким его назвал вызывающий.
 *
 * Нужен небольшим встроенным хранилищам, которые появились до
 * управляемой маршрутизации: у них одна цепочка, и «технический»
 * маршрут вроде `json` в них просто не настроен.
 */
export function requestedRouteOnly(request: LlmRequest): RouteResolution {
  const requested = request.metadata.requested_route ?? request.metadata.route ?? "chat";
  return fixed(requested, isEvaRoute(requested) ? requested : "chat", "requested", ["caller_requested_route"]);
}

export function isEvaRoute(value: string): value is EvaRoute {
  return (EVA_ROUTES as readonly string[]).includes(value);
}

function fixed(
  requestedRoute: string,
  effectiveRoute: EvaRoute,
  source: RouteResolution["source"],
  reasons: string[],
): RouteResolution {
  return { requestedRoute, effectiveRoute, source, reasons };
}
