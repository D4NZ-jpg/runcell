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

export class NotImplementedError extends RuncellError {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
