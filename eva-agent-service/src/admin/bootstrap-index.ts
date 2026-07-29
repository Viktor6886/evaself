import pg from "pg";

import { createLogger } from "../logger.js";
import { runAdminBootstrap } from "./bootstrap.js";
import { loadMasterKey, SecretStore } from "./secret-store.js";

const { Pool } = pg;

async function main(): Promise<void> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL обязателен");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    application_name: "evaself-admin-bootstrap",
  });
  try {
    const masterKey = await loadMasterKey();
    const store = new SecretStore({ masterKey, pool });
    const result = await runAdminBootstrap(pool, store);
    const logger = createLogger("info", "evaself-admin-bootstrap");
    logger.info("Bootstrap административной панели завершён", {
      already_completed: result.alreadyCompleted,
      owner_created: result.ownerCreated,
      settings_imported: result.settingsImported,
      secrets_imported: result.secretsImported,
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const logger = createLogger("error", "evaself-admin-bootstrap");
  logger.error("Bootstrap административной панели не завершён", {
    code: error instanceof Error ? error.name : "unknown_error",
  });
  process.exit(1);
});
