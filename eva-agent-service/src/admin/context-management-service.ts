import { InternalAgentClient } from "./provider-service.js";

export class ContextManagementAdminService {
  constructor(private readonly agent: InternalAgentClient) {}

  async get() {
    return await this.agent.request("/v1/context-management");
  }

  async update(body: Record<string, unknown>) {
    return await this.agent.request("/v1/context-management", {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async updateConversation(id: string, contextWindowLimit: number) {
    return await this.agent.request(
      `/v1/context-management/conversations/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ context_window_limit: contextWindowLimit }),
      },
    );
  }
}
