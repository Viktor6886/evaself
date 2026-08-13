/** Canonical HTTP client for callers that live in the agent-service process. */
export class LlmRouterClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly call: typeof fetch = fetch) {}

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, any>> {
    const response = await this.call(`${this.baseUrl.replace(/\/+$/u, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`LLM Router HTTP ${response.status}`);
    return JSON.parse(text) as Record<string, any>;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const body = await this.request("/embeddings", { model: "eva/embeddings", input: [text] }, signal);
    const vector: unknown = body.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== 1536 || vector.some((x) => typeof x !== "number")) throw new Error("LLM Router embeddings invalid");
    return vector as number[];
  }

  async complete(body: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const response = await this.request("/chat/completions", body, signal);
    return String(response.choices?.[0]?.message?.content ?? "");
  }
}