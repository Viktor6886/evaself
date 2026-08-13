import type { AdminRole } from "./admin/auth-service.js";

declare module "fastify" {
  interface FastifyContextConfig {
    roles?: AdminRole[];
    csrfExempt?: boolean;
    sudoScope?: string;
    tenantAccess?: "cross-user";
    public?: boolean;
  }
}
