import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type {
  AdmissionAdapter,
  AdmissionOptions,
  RunAdmissionOptions,
} from './admission.js';
import { InvalidOptionError } from './errors.js';

export const DEFAULT_ADMISSION_POOL = 'default';
export const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

/** Resolved admission settings for one run. */
export interface RunAdmissionContext {
  adapter: AdmissionAdapter;
  pool: string;
  workload: string | undefined;
  metadata: Readonly<Record<string, unknown>>;
  maxWaitMs: number | undefined;
  cleanupTimeoutMs: number;
}

/**
 * Lineage, budget, and cancellation for one run. Host tools execute inside
 * their run's context, so a RunCell agent started from a tool becomes a
 * child: it inherits lineage, admission, the remaining time budget, and
 * cancellation.
 */
export interface RunContext {
  runId: string;
  rootRunId: string;
  parentRunId: string | undefined;
  /** Aborted by caller cancellation, parent cancellation, or the run deadline. */
  signal: AbortSignal | undefined;
  /** Epoch-ms run deadline, inherited from the parent when earlier. */
  deadline: number | undefined;
  admission: RunAdmissionContext | undefined;
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
 * from a host tool). Validates admission inheritance and selection and
 * throws before any work starts. `dispose` stops the run-deadline timer.
 */
export function createRunContext({
  admission: agentAdmission,
  runAdmission,
  timeoutMs,
  signal: callerSignal,
  parent = currentRunContext(),
}: {
  admission: AdmissionOptions | undefined;
  runAdmission: RunAdmissionOptions | undefined;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  parent?: RunContext | undefined;
}): { context: RunContext; dispose: () => void } {
  const runId = randomUUID();
  const now = Date.now();
  const ownDeadline = timeoutMs !== undefined ? now + timeoutMs : undefined;
  const deadline = minDefined(ownDeadline, parent?.deadline);

  const admission = resolveRunAdmission(
    agentAdmission,
    runAdmission,
    parent?.admission,
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
      admission,
    },
    dispose: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Admission selection precedence:
 * - adapter: the agent's, else the parent's (children are never exempt);
 * - pool/workload: per-run selection, else the parent's when the adapter is
 *   shared, else the agent's defaults, else `'default'`; a workload is only
 *   inherited together with its pool;
 * - metadata: agent defaults, then inherited, then per-run (later wins);
 * - maxWaitMs: per-run, else agent, else inherited.
 */
function resolveRunAdmission(
  agent: AdmissionOptions | undefined,
  run: RunAdmissionOptions | undefined,
  parent: RunAdmissionContext | undefined,
): RunAdmissionContext | undefined {
  const adapter = agent?.adapter ?? parent?.adapter;
  if (!adapter) {
    if (run !== undefined) {
      throw new InvalidOptionError(
        'run "admission" options require an admission adapter on the agent ' +
          '(or an admitted parent run).',
      );
    }
    return undefined;
  }
  const inherited = parent?.adapter === adapter ? parent : undefined;
  const agentPool = agent?.pool ?? DEFAULT_ADMISSION_POOL;
  const pool = run?.pool ?? inherited?.pool ?? agentPool;
  const workload =
    run?.workload ??
    (inherited?.pool === pool ? inherited.workload : undefined) ??
    (pool === agentPool ? agent?.workload : undefined);
  const resolved: RunAdmissionContext = {
    adapter,
    pool,
    workload,
    metadata: {
      ...agent?.metadata,
      ...parent?.metadata,
      ...run?.metadata,
    },
    maxWaitMs: run?.maxWaitMs ?? agent?.maxWaitMs ?? parent?.maxWaitMs,
    cleanupTimeoutMs:
      agent?.cleanupTimeoutMs ??
      parent?.cleanupTimeoutMs ??
      DEFAULT_CLEANUP_TIMEOUT_MS,
  };
  adapter.validate?.({ pool, workload });
  return resolved;
}

export function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.min(a, b);
}
