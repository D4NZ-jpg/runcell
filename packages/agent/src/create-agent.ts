import type { ExtensionFactory, PiThinkingLevel } from '@local/harness-pi-raw';
import { normalizeCredentials, type CredentialPlan } from './credentials.js';
import { InvalidOptionError } from './errors.js';
import { normalizeFiles } from './files.js';
import { defaultRuntime, type RuncellRuntime } from './runtime.js';
import { resolveSandboxConfig, type SandboxConfig } from './sandbox.js';
import { getSandboxInternals } from './sandbox-handle.js';
import { getThreadInternals } from './thread.js';
import type {
  Agent,
  AgentOptions,
  AgentSchema,
  RunOptionsBase,
  RunResult,
} from './types.js';

type RunInput = RunOptionsBase & { schema?: AgentSchema };

const RESERVED_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'ls',
  'submitResult',
  'fileChange',
]);

/**
 * Internal, fully-validated configuration derived from {@link AgentOptions}.
 * Exposed for unit testing; not part of the public surface.
 */
export interface ResolvedAgentConfig {
  model: string;
  systemPrompt: string | undefined;
  credentials: CredentialPlan;
  toolNames: string[];
  sandbox: SandboxConfig;
  maxRepairs: number;
  extensions: readonly ExtensionFactory[];
  thinkingLevel: PiThinkingLevel | undefined;
}

const THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

function validateThinkingLevel(
  value: unknown,
  label: string,
): PiThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!THINKING_LEVELS.includes(value as PiThinkingLevel)) {
    throw new InvalidOptionError(
      `${label} must be one of ${THINKING_LEVELS.join(', ')}, received: ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value as PiThinkingLevel;
}

/**
 * Validate agent options eagerly and resolve them to a concrete config.
 */
export function resolveAgentConfig(
  options: AgentOptions,
  context: { nodeEnv?: string | undefined } = {},
): ResolvedAgentConfig {
  if (typeof options.model !== 'string' || options.model.trim().length === 0) {
    throw new InvalidOptionError('createAgent requires a non-empty "model".');
  }

  const maxRepairs = options.maxRepairs ?? 1;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
    throw new InvalidOptionError(
      `"maxRepairs" must be a non-negative integer, received: ${String(
        options.maxRepairs,
      )}`,
    );
  }

  const sandbox = resolveSandboxConfig(options.sandbox);

  const credentials = normalizeCredentials(options.credentials, {
    nodeEnv: context.nodeEnv,
  });

  const toolNames = Object.keys(options.tools ?? {});
  const reservedToolName = toolNames.find(name =>
    RESERVED_TOOL_NAMES.has(name),
  );
  if (reservedToolName) {
    throw new InvalidOptionError(
      `Tool name "${reservedToolName}" is reserved by runcell.`,
    );
  }

  const extensions = options.pi?.extensions ?? [];
  if (extensions.some(extension => typeof extension !== 'function')) {
    throw new InvalidOptionError(
      '"pi.extensions" entries must be extension factory functions.',
    );
  }

  const thinkingLevel = validateThinkingLevel(
    options.pi?.thinkingLevel,
    '"pi.thinkingLevel"',
  );

  return {
    model: options.model,
    systemPrompt: options.systemPrompt,
    credentials,
    toolNames,
    sandbox,
    maxRepairs,
    extensions,
    thinkingLevel,
  };
}

/**
 * Validate the options for a single run. Throws before any work starts.
 */
export function validateRunOptions(
  options: RunOptionsBase & { schema?: AgentSchema },
): void {
  if (
    typeof options.prompt !== 'string' ||
    options.prompt.trim().length === 0
  ) {
    throw new InvalidOptionError('run requires a non-empty "prompt".');
  }
  if (options.schema !== undefined && !isAgentSchema(options.schema)) {
    throw new InvalidOptionError(
      'run "schema" must be Standard Schema-compatible.',
    );
  }
  if (options.files !== undefined) {
    normalizeFiles(options.files);
  }
  // A live sandbox handle is reused as-is; a sandbox option is validated eagerly.
  if (
    options.sandbox !== undefined &&
    getSandboxInternals(options.sandbox) === undefined
  ) {
    resolveSandboxConfig(options.sandbox);
  }
  if (
    options.thread !== undefined &&
    getThreadInternals(options.thread) === undefined
  ) {
    throw new InvalidOptionError(
      'run "thread" must be created with createThread or threadFromJSON.',
    );
  }
  validateThinkingLevel(options.pi?.thinkingLevel, 'run "pi.thinkingLevel"');
}

function isAgentSchema(value: unknown): value is AgentSchema {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const standard = (value as { '~standard'?: unknown })['~standard'];
  return (
    standard != null &&
    typeof standard === 'object' &&
    typeof (standard as { validate?: unknown }).validate === 'function'
  );
}

/**
 * Create an agent bound to a model, credentials, tools and event callbacks.
 */
export function createAgent(
  options: AgentOptions,
  context: {
    nodeEnv?: string | undefined;
    runtime?: RuncellRuntime | undefined;
  } = {},
): Agent {
  const nodeEnv =
    context.nodeEnv ??
    (typeof process !== 'undefined' ? process.env['NODE_ENV'] : undefined);

  const config = resolveAgentConfig(options, { nodeEnv });
  const runtime = context.runtime ?? defaultRuntime;

  const run = (runOptions: RunInput): Promise<RunResult<unknown>> =>
    Promise.resolve(runOptions).then(opts => {
      validateRunOptions(opts);
      return runtime.run({ agentOptions: options, config, runOptions: opts });
    });

  const stream = (runOptions: RunInput) => {
    const text = createTextStream();
    const result = Promise.resolve(runOptions)
      .then(opts => {
        validateRunOptions(opts);
        return runtime.run({
          agentOptions: options,
          config,
          runOptions: opts,
          onTextDelta: text.push,
        });
      })
      .finally(() => {
        text.close();
      });
    // A consumer may iterate only textStream; pre-observe the rejection so a
    // failed run never surfaces as an unhandled rejection, while `result`
    // still rejects for callers that await it.
    void result.catch(() => undefined);
    return { textStream: text.iterable, result };
  };

  return { run, stream } as Agent;
}

/**
 * A single-producer, single-consumer async string stream. `push` enqueues a
 * delta; `close` ends iteration; `iterable` is consumed with `for await`.
 */
function createTextStream(): {
  push: (value: string) => void;
  close: () => void;
  iterable: AsyncIterable<string>;
} {
  const buffer: string[] = [];
  let pending: ((result: IteratorResult<string>) => void) | undefined;
  let done = false;

  const push = (value: string): void => {
    if (done) {
      return;
    }
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve({ value, done: false });
    } else {
      buffer.push(value);
    }
  };

  const close = (): void => {
    if (done) {
      return;
    }
    done = true;
    if (pending) {
      const resolve = pending;
      pending = undefined;
      resolve({ value: undefined, done: true });
    }
  };

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<string>> => {
        const next = buffer.shift();
        if (next !== undefined) {
          return Promise.resolve({ value: next, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<string>>(resolve => {
          pending = resolve;
        });
      },
    }),
  };

  return { push, close, iterable };
}
