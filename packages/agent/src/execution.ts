import type {
  ExecutionError,
  ExecutionUsage,
  RunExecution,
  RunUsage,
} from './types.js';

// Sidecars preserve foreign/frozen error identity and never mutate provider errors.
const executions = new WeakMap<object, RunExecution>();

/** Inspect a built-in runtime failure without depending on its error class. */
export function getRunExecution(error: unknown): RunExecution | undefined {
  return isObject(error) ? executions.get(error) : undefined;
}

export function recordRunExecution(
  error: object,
  execution: RunExecution,
): void {
  executions.set(error, execution);
}

export function emptyExecutionUsage(
  status: ExecutionUsage['status'] = 'complete',
): ExecutionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costMeasured: status === 'complete',
    status,
  };
}

export function totalExecutionUsage(
  attempts: readonly { usage: Readonly<ExecutionUsage> }[],
): ExecutionUsage {
  const total = emptyExecutionUsage();
  let hasMeasurement = false;
  for (const { usage } of attempts) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.totalTokens += usage.totalTokens;
    total.costUsd += usage.costUsd;
    total.costMeasured &&= usage.costMeasured;
    hasMeasurement ||= usage.status !== 'unknown';
  }
  if (attempts.some(({ usage }) => usage.status !== 'complete')) {
    total.status = hasMeasurement ? 'partial' : 'unknown';
  }
  return total;
}

/** Keep the legacy usage shape separate from completeness metadata. */
export function runUsage(usage: Readonly<ExecutionUsage>): RunUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    costUsd: usage.costUsd,
    costMeasured: usage.costMeasured,
  };
}

function isObject(value: unknown): value is object {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  );
}

function read(value: unknown, key: string): unknown {
  try {
    return isObject(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function retryAfter(value: unknown, now: number): number | undefined {
  if (typeof value !== 'string') return undefined;
  const seconds = Number(value);
  if (value.trim() && Number.isFinite(seconds)) {
    return seconds >= 0 && Number.isFinite(seconds * 1000)
      ? seconds * 1000
      : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function header(headers: unknown): unknown {
  try {
    if (headers instanceof Headers) return headers.get('retry-after');
    if (isObject(headers)) {
      const entry = Object.entries(headers).find(
        ([key]) => key.toLowerCase() === 'retry-after',
      );
      return entry?.[1];
    }
  } catch {
    // Uninspectable metadata is unavailable, not a second runtime failure.
  }
  return undefined;
}

/** Normalize available evidence without putting raw messages/causes in telemetry. */
export function executionError(
  error: unknown,
  origin: ExecutionError['origin'],
  cancelled: boolean,
  now = Date.now(),
): ExecutionError {
  const result: ExecutionError = {
    kind: cancelled ? 'cancelled' : 'unknown',
    origin,
  };
  const seen = new Set<unknown>();
  let current = error;
  let messageKind: ExecutionError['kind'] = 'unknown';
  while (isObject(current) && !seen.has(current)) {
    seen.add(current);
    const name = read(current, 'name');
    if (name === 'ExtensionError' || name === 'PiExtensionError')
      result.origin = 'extension';
    if (name === 'AI_ToolExecutionError' || name === 'ToolExecutionError')
      result.origin = 'tool';
    if (name === 'CredentialError') {
      result.origin = 'credentials';
      messageKind = 'authentication';
    }
    if (name === 'InvalidOptionError' || name === 'IncompleteResultError')
      result.origin = 'validation';
    if (
      result.origin === 'runtime' &&
      (name === 'AI_APICallError' || name === 'APICallError')
    )
      result.origin = 'provider';
    const status =
      read(current, 'statusCode') ??
      read(current, 'status') ??
      read(read(current, 'response'), 'status');
    if (
      result.statusCode === undefined &&
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
    ) {
      result.statusCode = status;
    }
    const headers =
      read(current, 'responseHeaders') ??
      read(current, 'headers') ??
      read(read(current, 'response'), 'headers');
    result.retryAfterMs ??= retryAfter(header(headers), now);
    const message = read(current, 'message');
    if (typeof message === 'string' && messageKind === 'unknown') {
      if (
        /OAuth refresh failed|No API key|\b401\b|Unauthorized|invalid_grant|authentication_error/i.test(
          message,
        )
      )
        messageKind = 'authentication';
      else if (/\b429\b|rate_limit_error/i.test(message))
        messageKind = 'rate_limit';
      else if (/\b(?:500|502|503|504|529)\b|overloaded_error/i.test(message))
        messageKind = 'provider_unavailable';
      else if (/invalid_request_error/i.test(message))
        messageKind = 'invalid_request';
    }
    current = read(current, 'cause');
  }
  if (cancelled) return result;
  if (result.origin !== 'provider' && result.origin !== 'credentials')
    return result;
  const status = result.statusCode;
  result.kind =
    status === 401
      ? 'authentication'
      : status === 429
        ? 'rate_limit'
        : status !== undefined && status >= 500
          ? 'provider_unavailable'
          : status !== undefined && [400, 404, 413, 422].includes(status)
            ? 'invalid_request'
            : messageKind;
  return result;
}
