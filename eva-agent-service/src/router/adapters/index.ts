import type { ProviderAdapter, ProviderProfile } from "../types.js";
import { anthropicAdapter } from "./anthropic.js";
import { geminiAdapter } from "./gemini.js";
import { openAiAdapter } from "./openai.js";
import { responsesAdapter } from "./responses.js";

const ADAPTERS: Partial<Record<ProviderProfile["protocol"], ProviderAdapter>> = {
  "openai-compatible": openAiAdapter,
  "openai-responses": responsesAdapter,
  "anthropic-compatible": anthropicAdapter,
  "gemini-compatible": geminiAdapter,
};

export function adapterForProtocol(protocol: ProviderProfile["protocol"]): ProviderAdapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) throw new Error(`protocol ${protocol} не поддерживается`);
  return adapter;
}
