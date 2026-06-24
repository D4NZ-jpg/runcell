import { normalizeCredentials, type CredentialPlan } from './credentials.js';
import { InvalidOptionError } from './errors.js';
import { normalizeFiles } from './files.js';
import { defaultRuntime, type RuncellRuntime } from './runtime.js';
import { resolveSandboxConfig, type SandboxConfig } from './sandbox.js';
import type { Agent, AgentOptions, AgentSchema, RunOptions } from './types.js';

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
  instructions: string | undefined;
  credentials: CredentialPlan;
  toolNames: string[];
  sandbox: SandboxConfig;
  maxRepairs: number;
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

  return {
    model: options.model,
    instructions: options.instructions,
    credentials,
    toolNames,
    sandbox,
    maxRepairs,
  };
}

/**
 * Validate the options for a single run. Throws before any work starts.
 */
export function validateRunOptions<TSchema extends AgentSchema>(
  options: RunOptions<TSchema>,
): void {
  if (
    typeof options.prompt !== 'string' ||
    options.prompt.trim().length === 0
  ) {
    throw new InvalidOptionError('run requires a non-empty "prompt".');
  }
  if (!isAgentSchema(options.schema)) {
    throw new InvalidOptionError(
      'run requires a Standard Schema-compatible "schema".',
    );
  }
  if (options.files !== undefined) {
    normalizeFiles(options.files);
  }
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

  return {
    run(runOptions) {
      return Promise.resolve(runOptions).then(opts => {
        validateRunOptions(opts);
        return runtime.run({ agentOptions: options, config, runOptions: opts });
      });
    },
  };
}
