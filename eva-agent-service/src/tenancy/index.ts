export {
  isTenantTable,
  MULTI_PARTY_TABLES,
  NON_TENANT_USER_ID_TABLES,
  TENANT_TABLES,
  tenantColumns,
} from "./tables.js";
export { analyzeSql, isTelegramColumn } from "./sql.js";
export type { SqlAnalysis, TenantBinding, TenantTableUse } from "./sql.js";
export {
  adminScope,
  assertQueryAllowed,
  bindUserId,
  currentScope,
  enterScope,
  runInScope,
  systemScope,
  TenantViolationError,
  userScope,
} from "./scope.js";
export type { AdminScope, SystemScope, TenantScope, UserScope } from "./scope.js";
export { guardPool, guardQuery } from "./guarded-pool.js";
