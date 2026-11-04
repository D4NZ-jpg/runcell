import type { RunUsage } from './types.js';

interface RunFailureOptions {
  cause?: unknown;
  usage?: RunUsage;
}

/**
 * Return reconciled run usage carried by an arbitrary thrown value, when it
 * has the complete runtime-produced shape.
 */
export function getRunUsage(value: unknown): RunUsage | undefined {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return undefined;
  }

  try {
    const usage = (value as { usage?: unknown }).usage;
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
      return undefined;
    }

    const candidate = usage as Partial<Record<keyof RunUsage, unknown>>;
    const tokenFields = [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'totalTokens',
    ] as const;
    if (
      tokenFields.some(
        field =>
          !Number.isSafeInteger(candidate[field]) ||
          (candidate[field] as number) < 0,
      ) ||
      typeof candidate.costUsd !== 'number' ||
      !Number.isFinite(candidate.costUsd) ||
      candidate.costUsd < 0 ||
      typeof candidate.costMeasured !== 'boolean'
    ) {
      return undefined;
    }

    const bucketTotal =
      (candidate.inputTokens as number) +
      (candidate.outputTokens as number) +
      (candidate.cacheReadTokens as number) +
      (candidate.cacheWriteTokens as number);
    return candidate.totalTokens === bucketTotal
      ? (usage as RunUsage)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Base class for all errors thrown by runcell.
 */
export class RuncellError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RuncellError';
  }
}

/**
 * Thrown when an agent option or run option fails validation before any work
 * is started (e.g. an unsafe workspace path or a missing model).
 */
export class InvalidOptionError extends RuncellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidOptionError';
  }
}

/**
 * Thrown when the agent finishes without producing a valid `submitResult`
 * payload, even after the allowed repair turns. Runtime-created post-session
 * failures carry `usage`; manually constructed and pre-session failures do not.
 */
export class IncompleteResultError extends RuncellError {
  declare readonly usage?: RunUsage;

  constructor(message: string, options?: RunFailureOptions) {
    super(message, options);
    this.name = 'IncompleteResultError';
    if (options?.usage !== undefined) {
      Object.defineProperty(this, 'usage', {
        value: options.usage,
        configurable: true,
        enumerable: true,
      });
    }
  }
}

/**
 * Thrown when the engine reports a terminal error for a turn — for example a
 * provider API failure or an aborted request. The original error is available
 * as `cause`. Runtime-created post-session failures carry `usage`; manually
 * constructed and pre-session failures do not.
 */
export class TurnError extends RuncellError {
  declare readonly usage?: RunUsage;

  constructor(message: string, options?: RunFailureOptions) {
    super(message, options);
    this.name = 'TurnError';
    if (options?.usage !== undefined) {
      Object.defineProperty(this, 'usage', {
        value: options.usage,
        configurable: true,
        enumerable: true,
      });
    }
  }
}

/**
 * Thrown when an explicitly supplied Pi extension fails to initialize or
 * registers a tool that collides with a reserved or user tool. Always raised
 * before any model request is attempted. The original error is available as
 * `cause`.
 */
export class ExtensionError extends RuncellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExtensionError';
  }
}

/**
 * Thrown when credentials are misconfigured for the current environment
 * (for example, local file credentials used in production without opt-in).
 */
export class CredentialError extends RuncellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialError';
  }
}

/** Identifies the provider request a {@link ConcurrencyError} belongs to. */
export interface ConcurrencyErrorDetails {
  /** Name of the concurrency limiter. */
  limiter?: string;
  workload?: string;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
  requestId?: string;
}

interface ConcurrencyErrorOptions extends ConcurrencyErrorDetails {
  cause?: unknown;
  usage?: RunUsage;
}

/**
 * Base class for concurrency-limit failures. The provider request was never
 * sent, or (for {@link ConcurrencyLeaseLostError}) was aborted, which
 * distinguishes these from provider failures ({@link TurnError}).
 * Runtime-created failures carry the run's `usage`.
 */
export class ConcurrencyError extends RuncellError {
  declare readonly usage?: RunUsage;
  readonly limiter: string | undefined;
  readonly workload: string | undefined;
  readonly runId: string | undefined;
  readonly rootRunId: string | undefined;
  readonly parentRunId: string | undefined;
  readonly requestId: string | undefined;

  constructor(message: string, options: ConcurrencyErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'ConcurrencyError';
    this.limiter = options.limiter;
    this.workload = options.workload;
    this.runId = options.runId;
    this.rootRunId = options.rootRunId;
    this.parentRunId = options.parentRunId;
    this.requestId = options.requestId;
    if (options.usage !== undefined) {
      Object.defineProperty(this, 'usage', {
        value: options.usage,
        configurable: true,
        enumerable: true,
      });
    }
  }
}

/**
 * No slot was free before the deadline: the workload's `maxWaitMs` or the
 * run's remaining `timeoutMs`, whichever came first. The provider was not
 * called.
 */
export class ConcurrencyTimeoutError extends ConcurrencyError {
  constructor(message: string, options?: ConcurrencyErrorOptions) {
    super(message, options);
    this.name = 'ConcurrencyTimeoutError';
  }
}

/** The limiter's queue already holds `maxQueued` waiting requests. The provider was not called. */
export class ConcurrencyQueueFullError extends ConcurrencyError {
  constructor(message: string, options?: ConcurrencyErrorOptions) {
    super(message, options);
    this.name = 'ConcurrencyQueueFullError';
  }
}

/**
 * The limiter failed, for example because its database is unreachable.
 * RunCell fails closed: the provider was not called. The limiter's error is
 * the `cause`.
 */
export class ConcurrencyLimiterError extends ConcurrencyError {
  constructor(message: string, options?: ConcurrencyErrorOptions) {
    super(message, options);
    this.name = 'ConcurrencyLimiterError';
  }
}

/**
 * A held slot could not be renewed before its lease expired. RunCell aborted
 * the provider request that held it and stopped the run.
 */
export class ConcurrencyLeaseLostError extends ConcurrencyError {
  constructor(message: string, options?: ConcurrencyErrorOptions) {
    super(message, options);
    this.name = 'ConcurrencyLeaseLostError';
  }
}

/**
 * The limiter configuration is invalid, a run selected an unknown workload,
 * or the limiter's settings conflict with those other workers use for the
 * same shared limiter.
 */
export class ConcurrencyConfigError extends ConcurrencyError {
  constructor(message: string, options?: ConcurrencyErrorOptions) {
    super(message, options);
    this.name = 'ConcurrencyConfigError';
  }
}

export class NotImplementedError extends RuncellError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
