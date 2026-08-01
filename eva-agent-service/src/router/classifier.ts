import type { LlmRequest, RoutingSettings } from "./types.js";
import { estimateTokens } from "./normalize.js";

export const EVA_ROUTES = [
  "chat", "deep", "fast", "classifier", "research", "safety",
  "vision", "tools", "json", "single",
] as const;
export type EvaRoute = typeof EVA_ROUTES[number];

export interface RouteClassificationResult {
  requestedRoute: string;
  effectiveRoute: EvaRoute;
  confidence: number;
  source: "purpose" | "rule" | "score" | "llm" | "forced" | "disabled_single_mode";
  score: number;
  reasons: string[];
}

export interface DeterministicClassification {
  result: RouteClassificationResult;
  ambiguous: boolean;
  latestMessage: string;
}

export function classifyDeterministically(
  request: LlmRequest,
  settings: RoutingSettings,
): DeterministicClassification {
  const requestedRoute = request.metadata.requested_route ?? request.metadata.route ?? "chat";
  if (settings.mode === "single") {
    return fixed(requestedRoute, "single", "disabled_single_mode", 1, 0, ["global_single_mode"]);
  }
  if (request.metadata.skip_auto_classification) {
    const route = isEvaRoute(requestedRoute) ? requestedRoute : "chat";
    return fixed(requestedRoute, route, "forced", 1, 0, ["auto_classification_skipped"]);
  }

  const purpose = request.metadata.purpose ?? "chat";
  const purposeRoute: Partial<Record<string, EvaRoute>> = {
    scheduler: "fast",
    maintenance: request.response_format ? "json" : "fast",
    profile: "json",
    goal_review: "deep",
    partner_analysis: "deep",
    research: "research",
  };
  if (purposeRoute[purpose]) {
    return fixed(requestedRoute, purposeRoute[purpose]!, "purpose", 1, 0, [`purpose_${purpose}`]);
  }

  if (requestedRoute !== "chat" && isEvaRoute(requestedRoute)) {
    return fixed(requestedRoute, requestedRoute, "forced", 1, 0, ["server_requested_route"]);
  }
  if (request.metadata.crisis_level === "high" || request.metadata.crisis_level === "critical") {
    return fixed(requestedRoute, "safety", "rule", 1, 5, ["crisis_high"]);
  }
  if (request.metadata.has_image) {
    return fixed(requestedRoute, "vision", "rule", 1, 0, ["vision_required"]);
  }
  if (request.response_format?.type === "json_object") {
    return fixed(requestedRoute, "json", "rule", 1, 0, ["json_required"]);
  }
  if (!settings.auto_routing_enabled) {
    return fixed(requestedRoute, "chat", "forced", 1, 0, ["auto_routing_disabled"]);
  }

  const latestMessage = latestUserMessage(request);
  const lower = latestMessage.toLocaleLowerCase("ru");
  if (/(найди в интернете|поищи в интернете|источник|источники|research|web search)/u.test(lower)) {
    return fixed(requestedRoute, "research", "rule", 0.96, 3, ["internet_research_required"], latestMessage);
  }
  if (/(напомни|создай задачу|запиши задачу|поставь напоминание|remind me|create task)/u.test(lower)) {
    return fixed(requestedRoute, "tools", "rule", 0.98, -3, ["tool_required"], latestMessage);
  }

  const reasons: string[] = [];
  let score = 0;
  const add = (value: number, code: string, pattern: RegExp) => {
    if (pattern.test(lower)) { score += value; reasons.push(code); }
  };
  add(5, "high_risk_topic", /(суицид|самоубий|навредить себе|опасн|насили|suicid|self harm)/u);
  add(4, "important_decision", /(?:увольн|развод|переез|операци|ипотек|важн(?:ое|ый) решени|should i quit|divorc)/u);
  add(1, "decision_question", /(стоит ли|следует ли|как мне решить|should i)/u);
  add(3, "relationship_analysis", /(отношени|партн[её]р|муж|жена|поведени|relationship)/u);
  add(3, "recurring_pattern", /(снова|постоянно|каждый раз|повторя|паттерн|again and again)/u);
  add(3, "document_analysis", /(документ|договор|резюме|отч[её]т|document|contract)/u);
  add(3, "source_comparison", /(источник|исследован|сопостав|research|sources)/u);
  const relatedKinds = [
    Number(request.metadata.related_goals ?? 0) > 0,
    Number(request.metadata.related_tasks ?? 0) > 0,
    Number(request.metadata.related_recent_events ?? 0) > 0,
  ].filter(Boolean).length;
  if (relatedKinds >= 2) { score += 3; reasons.push("multi_factor_context"); }
  if (estimateTokens(request) >= 8_000) { score += 2; reasons.push("large_relevant_context"); }
  add(2, "multi_option_comparison", /(сравни|вариант|плюсы и минусы|compare|options)/u);
  add(2, "strategy", /(стратег|подробн(?:ый|ая) план|долгосроч|strategy|long.term)/u);
  add(2, "multi_factor_analysis", /\?.*\?/u);
  add(1, "explicit_deep_analysis", /(глубоко|детально проанализ|deep analysis)/u);
  add(-2, "simple_question", /^(что такое|кто такой|сколько|когда|where|what is)/u);
  add(-3, "simple_ack", /^(привет|здравствуй|доброе утро|добрый день|hello|hi)[!.\s]*$/u);
  add(-3, "simple_ack", /^(спасибо|благодарю|thanks|thank you)[!.\s]*$/u);
  add(-3, "simple_ack", /^(да|нет|ок|хорошо|согласен|готово|yes|no|ok|done)[!.\s]*$/u);

  const userMode = request.metadata.user_mode ?? "auto";
  if (userMode === "economy") { score += settings.economy_score_shift; reasons.push("economy_preference"); }
  if (userMode === "quality") { score += settings.quality_score_shift; reasons.push("quality_preference"); }

  let route: EvaRoute = score <= settings.fast_max_score
    ? "fast"
    : score >= settings.deep_min_score ? "deep" : "chat";
  if (userMode === "quality" && route === "fast" && !reasons.some((reason) =>
    ["simple_ack"].includes(reason))) route = "chat";

  const distance = Math.min(
    Math.abs(score - settings.fast_max_score),
    Math.abs(score - settings.deep_min_score),
  );
  const ambiguous = settings.auto_routing_enabled && reasons.length > 0 && distance <= 1 && route !== "fast";
  if (ambiguous) reasons.push("ambiguous_context");
  const confidence = reasons.length === 0 ? 0.55 : Math.min(0.95, 0.68 + distance * 0.08);
  return {
    result: { requestedRoute, effectiveRoute: route, confidence, source: "score", score, reasons },
    ambiguous,
    latestMessage,
  };
}

export function latestUserMessage(request: LlmRequest): string {
  const content = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const wrapped = /<USER_MESSAGE>\s*([\s\S]*?)\s*<\/USER_MESSAGE>/i.exec(content)?.[1];
  return (wrapped ?? content).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function isEvaRoute(value: string): value is EvaRoute {
  return (EVA_ROUTES as readonly string[]).includes(value);
}

function fixed(
  requestedRoute: string,
  effectiveRoute: EvaRoute,
  source: RouteClassificationResult["source"],
  confidence: number,
  score: number,
  reasons: string[],
  latestMessage = "",
): DeterministicClassification {
  return {
    result: { requestedRoute, effectiveRoute, source, confidence, score, reasons },
    ambiguous: false,
    latestMessage,
  };
}
