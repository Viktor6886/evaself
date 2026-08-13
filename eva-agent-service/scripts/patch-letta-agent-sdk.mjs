import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("node_modules/@letta-ai/letta-agent-sdk");
const replacements = [
  ["src/management-types.ts", '  contextWindowLimit?: AgentUpdateParams["context_window_limit"];', '  contextWindowLimit?: AgentUpdateParams["context_window_limit"];\n  compactionSettings?: AgentUpdateParams["compaction_settings"];'],
  ["src/management.ts", "    context_window_limit: options.contextWindowLimit,", "    context_window_limit: options.contextWindowLimit,\n    compaction_settings: options.compactionSettings,"],
  ["dist/index.js", "    context_window_limit: options.contextWindowLimit\n  };", "    context_window_limit: options.contextWindowLimit,\n    compaction_settings: options.compactionSettings\n  };"],
  ["dist/management-types.d.ts", '    contextWindowLimit?: AgentUpdateParams["context_window_limit"];', '    contextWindowLimit?: AgentUpdateParams["context_window_limit"];\n    compactionSettings?: AgentUpdateParams["compaction_settings"];'],
];

for (const [relative, before, after] of replacements) {
  const path = resolve(root, relative);
  const source = readFileSync(path, "utf8");
  if (source.includes(after)) continue;
  if (!source.includes(before)) throw new Error(`Unsupported Letta Agent SDK layout: ${relative}`);
  writeFileSync(path, source.replace(before, after));
}
