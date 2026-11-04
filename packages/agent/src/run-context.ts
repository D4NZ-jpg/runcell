import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  ConcurrencyLimiter,
  ConcurrencyOptions,
  RunConcurrencyOptions,
} from './concurrency.js';
import { InvalidOptionError } from './errors.js';

/** Resolved concurrency settings for one run. */
export interface RunConcurrencyContext {
  limiter: ConcurrencyLimiter;
  workload: string | undefined;
  metadata: Readonly<Record<string, unknown>>;
}

/**
 * Lineage, budget, and cancellation for one run. Host tools execute inside
 * their run's context, so a RunCell agent started from a tool becomes a
 * child: it inherits lineage, the concurrency limit, the remaining time
 * budget, and cancellation.
 */
export interface RunContext {
  runId: string;
  rootRunId: string;
  parentRunId: string | undefined;
  /** Aborted by caller cancellation, parent cancellation, or the run deadline. */
  signal: AbortSignal | undefined;
  /** Epoch-ms run deadline, inherited from the parent when earlier. */
  deadline: number | undefined;
  concurrency: RunConcurrencyContext | undefined;
}

const runContextStorage = new AsyncLocalStorage<RunContext>();

/** The context of the run whose tool is currently executing, if any. */
export function currentRunContext(): RunContext | undefined {
  return runContextStorage.getStore();
}

/** Execute `fn` as part of `context`'s run (used around host tools). */
export function runInContext<T>(context: RunContext, fn: () => T): T {
  return runContextStorage.run(context, fn);
}

/**
 * Build a run's context from its options and the enclosing run (when called
 * from a host tool). Validates the concurrency selection and throws before
 * any work starts. `dispose` stops the run-deadline timer.
 */
export function createRunContext({
  concurrency: agentConcurrency,
  runConcurrency,
  timeoutMs,
  signal: callerSignal,
  parent = currentRunContext(),
}: {
  concurrency: ConcurrencyOptions | undefined;
  runConcurrency: RunConcurrencyOptions | undefined;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  parent?: RunContext | undefined;
}): { context: RunContext; dispose: () => void } {
  const runId = randomUUID();
  const ownDeadline =
    timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  const deadline = minDefined(ownDeadline, parent?.deadline);

  const concurrency = resolveRunConcurrency(
    agentConcurrency,
    runConcurrency,
    parent?.concurrency,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const signals: AbortSignal[] = [];
  if (callerSignal) signals.push(callerSignal);
  if (parent?.signal) signals.push(parent.signal);
  if (ownDeadline !== undefined) {
    const controller = new AbortController();
    timer = setTimeout(() => {
      controller.abort(
        new DOMException(
          `Run exceeded its ${timeoutMs} ms time budget.`,
          'TimeoutError',
        ),
      );
    }, timeoutMs);
    signals.push(controller.signal);
  }
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  return {
    context: {
      runId,
      rootRunId: parent?.rootRunId ?? runId,
      parentRunId: parent?.runId,
      signal,
      deadline,
      concurrency,
    },
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Selection precedence:
 * - limiter: the run's, else the agent's, else the parent's. Children are
 *   never exempt: an agent without `concurrency` inherits its parent's.
 * - workload: the run's, else the parent's when the limiter is the same
 *   (so a child agent's own default cannot move work to another workload),
 *   else the agent's when the limiter is the agent's.
 * - metadata: agent, then inherited, then run (later wins).
 */
function resolveRunConcurrency(
  agent: ConcurrencyOptions | undefined,
  run: RunConcurrencyOptions | undefined,
  parent: RunConcurrencyContext | undefined,
): RunConcurrencyContext | undefined {
  const limiter = run?.limiter ?? agent?.limiter ?? parent?.limiter;
  if (!limiter) {
    if (run !== undefined) {
      throw new InvalidOptionError(
        'run "concurrency" needs a limiter: pass "concurrency.limiter" on ' +
          'the run or the agent.',
      );
    }
    return undefined;
  }
  const inherited = parent?.limiter === limiter ? parent : undefined;
  const workload =
    run?.workload ??
    inherited?.workload ??
    (agent?.limiter === limiter ? agent.workload : undefined);
  limiter.validateWorkload?.(workload);
  return {
    limiter,
    workload,
    metadata: { ...agent?.metadata, ...parent?.metadata, ...run?.metadata },
  };
}

export function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.min(a, b);
}
