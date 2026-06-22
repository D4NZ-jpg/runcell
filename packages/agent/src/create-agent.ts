import { normalizeCredentials, type CredentialPlan } from './credentials.js';
import { InvalidOptionError } from './errors.js';
import { normalizeFiles } from './files.js';
import { defaultRuntime, type RuncellRuntime } from './runtime.js';
import type { Agent, AgentOptions, RunOptions } from './types.js';
import type { ZodTypeAny } from 'zod';

/**
 * Internal, fully-validated configuration derived from {@link AgentOptions}.
 * Exposed for unit testing; not part of the public surface.
 */
export interface ResolvedAgentConfig {
  model: string;
  instructions: string | undefined;
  credentials: CredentialPlan;
  toolNames: string[];
  workspaceDir: string;
  maxRepairs: number;
}

/**
 * Validate agent options eagerly and resolve them to a concrete config. This
 * runs synchronously at construction time so misconfiguration fails fast.
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

  const workspaceDir = options.workspaceDir ?? '/workspace';
  if (!workspaceDir.startsWith('/')) {
    throw new InvalidOptionError(
      `"workspaceDir" must be an absolute sandbox path, received: ${workspaceDir}`,
    );
  }

  const credentials = normalizeCredentials(options.credentials, {
    nodeEnv: context.nodeEnv,
  });

  const toolNames = Object.keys(options.tools ?? {});

  return {
    model: options.model,
    instructions: options.instructions,
    credentials,
    toolNames,
    workspaceDir,
    maxRepairs,
  };
}

/**
 * Validate the options for a single run. Throws before any work starts.
 */
export function validateRunOptions<TSchema extends ZodTypeAny>(
  options: RunOptions<TSchema>,
): void {
  if (
    typeof options.prompt !== 'string' ||
    options.prompt.trim().length === 0
  ) {
    throw new InvalidOptionError('run requires a non-empty "prompt".');
  }
  if (options.files !== undefined) {
    normalizeFiles(options.files);
  }
}

/**
 * Create an agent bound to a model, credentials, tools and event callbacks.
 *
 * @remarks
 * The option/run validation pipeline is implemented; the sandbox + harness
 * execution path is still being wired up and currently throws
 * {@link NotImplementedError} from {@link Agent.run}.
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
