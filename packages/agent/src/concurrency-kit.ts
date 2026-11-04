/**
 * `runcell/concurrency`: building blocks for custom concurrency limiters.
 *
 * Application code needs only `createConcurrencyLimiter` and the
 * `concurrency` options from `runcell`. Import from this module to
 * implement a limiter on your own coordinator. It exports the settings
 * validation and allocation algorithm that the built-in limiters share, and
 * a conformance suite.
 */
export {
  DEFAULT_WORKLOAD,
  concurrencyLimitsFingerprint,
  resolveConcurrencyLimits,
  resolveWorkload,
  selectConcurrencyGrants,
} from './concurrency-policy.js';
export type {
  ConcurrencyWaiter,
  ResolvedConcurrencyLimits,
  ResolvedWorkload,
} from './concurrency-policy.js';
export { concurrencyConformanceCases } from './concurrency-conformance.js';
export type {
  ConcurrencyConformanceCase,
  ConcurrencyConformanceOptions,
  ConcurrencyConformanceSetup,
} from './concurrency-conformance.js';
export type {
  ConcurrencyLease,
  ConcurrencyLimiter,
  ConcurrencyLimits,
  ConcurrencyRequest,
  ConcurrencyStats,
  ConcurrencyWorkload,
} from './concurrency.js';
export {
  ConcurrencyConfigError,
  ConcurrencyError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
} from './errors.js';
