/**
 * CINEVISION provider readback barrel (FASE 1, GET-only, `API_IN_BROWSER`).
 *
 * Note on validation: `schemas.ts` is intentionally dependency-free —
 * `zod` is not declared in this package and adding it would require
 * editing `package.json` (outside this task's write scope). The
 * validators enforce the same contract (strip unknowns, fail closed,
 * one documented `is_trial` normalization); swapping the internals for
 * Zod later keeps every export signature unchanged.
 */

export {
  CINEVISION_ERROR_CODES,
  classifyHttpFailure,
  httpError,
  isChallengeBody,
  isChallengeSignals,
  isJsonContentType,
  transportError,
  type CinevisionErrorCode,
  type CinevisionReaderError,
  type HtmlChallengeSignals,
  type ReaderEvidence,
  type ReaderEvidenceSchema,
  type ReaderResult,
  type HttpFailureInput,
} from "./errors.js";
export {
  buildApiPath,
  buildApiUrl,
  CapabilityParamError,
  cancelInPageFetch,
  DEFAULT_TIMEOUT_MS,
  fetchCapability,
  type CapabilityParams,
  type CapabilityResponse,
  type CinevisionInPage,
  type FetchDeps,
  type InPageHtmlSignals,
  type InPageProjection,
  type InPageRequest,
  type InPageResult,
  type ReadCapability,
} from "./api-client.js";
export {
  normalizeIsTrial,
  parseCustomer,
  parseCustomerPage,
  parseIdentity,
  parseIntegrationList,
  parseLiveConnectionPage,
  parseLiveConnection,
  parsePackagePriceList,
  parseServerList,
  parseServerStatusList,
  type CustomerPage,
  type CustomerResult,
  type IdentityResult,
  type IntegrationSummary,
  type LiveConnection,
  type LiveConnectionPage,
  type PackagePrice,
  type ParseResult,
  type ServerStatus,
  type ServerSummary,
} from "./schemas.js";
export {
  listCustomers,
  listIntegrations,
  listPackagePrices,
  listServers,
  readConnections,
  readCreditBalance,
  readCustomer,
  readCustomerStatus,
  readIdentity,
  readLiveConnections,
  readServerStatus,
  type ConnectionAllowance as ConnectionAllowanceResult,
  type CustomerArgs,
  type CustomerStatus as CustomerStatusResult,
  type ListArgs,
  type LiveConnectionsArgs,
  type ReaderDeps,
} from "./readers.js";
