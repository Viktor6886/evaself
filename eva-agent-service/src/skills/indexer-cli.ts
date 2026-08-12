import { ArtifactRegistry } from "../artifacts/registry.js";
import { Database } from "../db.js";
import { FilesystemSkillIndexer } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const db = new Database(databaseUrl);
await db.connect();
try {
  const result = await new FilesystemSkillIndexer(new ArtifactRegistry(db), {
    root: ".skills",
    runtimeRoot: "/data/letta/.skills",
    environment: "production",
  }).sync();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await db.close();
}
