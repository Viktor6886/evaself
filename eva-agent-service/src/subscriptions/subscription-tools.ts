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
        "Только читает актуальный тариф, срок, оставшиеся дни и остатки сообщений за сутки, неделю и месяц для текущего собеседника. Вызывай при каждом вопросе о подписке, оплате или квотах: эти данные нельзя брать из памяти и нельзя изменять.",
        objectSchema({}),
        async (_args, runtime: AgentRuntimeContext) => await this.status.get(runtime.userId),
      ),
    ];
  }
}
