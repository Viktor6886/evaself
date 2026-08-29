import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";

import type { AgentRuntimeContext } from "../db.js";
import { objectSchema, type ToolBuilder } from "../tools/tool-kit.js";
import { SubscriptionStatusService } from "./status-service.js";

export class SubscriptionToolFactory {
  constructor(private readonly status: SubscriptionStatusService) {}

  build(tool: ToolBuilder): AnyAgentTool[] {
    return [
      tool(
        "get_subscription_status",
        "Статус подписки и лимитов",
        "Только читает актуальный тариф, срок, оставшиеся дни, текущие квоты и бесплатные сообщения собеседника. Используй, когда человек спрашивает о подписке, оплате или остатках. Данные изменять нельзя.",
        objectSchema({}),
        async (_args, runtime: AgentRuntimeContext) => await this.status.get(runtime.userId),
      ),
    ];
  }
}
