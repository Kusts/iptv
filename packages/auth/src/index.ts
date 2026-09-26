export { hashPassword, verifyPassword, assertPasswordPolicy } from "./passwords.js";
export {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  PLATFORM_ADMIN_ROLE,
  TENANT_OWNER_ROLE,
  TENANT_ADMIN_ROLE,
  TENANT_OPERATOR_ROLE,
  isKnownPermission,
  permissionsForRoles,
  hasPermission,
  requirePermission,
  resolveActor,
  ForbiddenError,
} from "./permissions.js";
export type { Permission, Actor, MembershipLoader } from "./permissions.js";
export {
  AUDIT_ACTOR_TYPES,
  buildAuditRow,
  writeAudit,
} from "./audit.js";
export type { AuditActorType, AuditEventInput, AuditRow, AuditWriter } from "./audit.js";
export {
  createAuth,
  normalizeEmail,
  assertEmail,
  bearerTokenFromHeader,
  AuthError,
} from "./auth.js";
export type {
  AuthConfig,
  AuthInstance,
  AuthUser,
  MembershipSummary,
  SessionInfo,
} from "./auth.js";
