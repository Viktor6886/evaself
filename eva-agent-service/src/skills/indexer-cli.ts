import { ArtifactRegistry } from "../artifacts/registry.js";
import { Database } from "../db.js";
import { FilesystemSkillIndexer } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const db = new Database(databaseUrl);
await db.connect();
try {
  const registry = new ArtifactRegistry(db);
  const environment = "production";
  const runtimeRoot = "/data/letta/.skills";
  let totalActive = 0, totalDisabled = 0;
  const roots = [".skills", "/app/skills"];
  for (const root of roots) {
    const r = await new FilesystemSkillIndexer(registry, {
      root,
      runtimeRoot: root === roots[0] ? runtimeRoot : undefined,
      environment,
    }).sync();
    totalActive += r.active;
    totalDisabled += r.disabled;
  }
  process.stdout.write(`${JSON.stringify({ active: totalActive, disabled: totalDisabled })}\n`);
} finally {
  await db.close();
}
