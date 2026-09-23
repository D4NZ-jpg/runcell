import { CredentialError } from './errors.js';

/**
 * A single stored credential for a provider.
 */
export type StoredCredential =
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | {
      type: 'oauth';
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

/**
 * The full credential blob persisted by a {@link CredentialStore}, keyed by
 * provider id (e.g. `anthropic`, `openai`).
 */
export type AuthBlob = Record<string, StoredCredential>;

/**
 * A shared, lockable credential store for production deployments that use
 * OAuth. Implementations back this with a database, KV store or secret
 * manager and provide a distributed lock so that concurrent deployments never
 * clobber a rotated refresh token. Concurrent calls to `withLock` must wait for
 * the lock rather than fail, because Pi may read multiple providers in parallel.
 */
export interface CredentialStore {
  withLock<T>(
    key: string,
    fn: (
      current: AuthBlob | undefined,
    ) => Promise<{ result: T; next?: AuthBlob }>,
  ): Promise<T>;
}

/**
 * How the agent should obtain provider credentials.
 *
 * - `{ type: 'env' }` — read provider API keys from environment variables.
 *   This is the default; applications may load those variables from `.env`.
 * - `'local'` — reuse the developer's local agent dir (`~/.pi/agent`); refused
 *   in production unless `allowInProduction` is set.
 * - `{ type: 'apiKeys' }` — explicit in-memory API keys (no refresh needed).
 * - `{ type: 'agentDir' }` — an explicit agent dir path holding `auth.json`.
 * - `{ type: 'shared' }` — a shared {@link CredentialStore} (OAuth in prod).
 */
export type CredentialSource =
  | 'local'
  | { type: 'local'; agentDir?: string; allowInProduction?: boolean }
  | { type: 'env' }
  | { type: 'apiKeys'; keys: Record<string, string> }
  | { type: 'agentDir'; path: string }
  | { type: 'shared'; key: string; store: CredentialStore };

/**
 * A single credential source, or a fallback chain of sources tried in
 * order. With a chain, a run starts on the first source; if it fails with a
 * credential error (revoked or unrefreshable login, missing key for the
 * provider, `401`) before any tool has executed, runcell retries the whole
 * run on the next source, firing `onCredentialFallback` for each hop.
 * Non-credential errors, and credential errors after a tool has executed
 * (retrying would repeat side effects), propagate immediately.
 */
export type Credentials = CredentialSource | readonly CredentialSource[];

/**
 * A resolved, validated description of how credentials will be obtained at run
 * time. Produced by {@link normalizeCredentials}.
 */
export type CredentialPlan =
  | { mode: 'local'; agentDir?: string }
  | { mode: 'env' }
  | { mode: 'apiKeys'; keys: Record<string, string> }
  | { mode: 'agentDir'; path: string }
  | { mode: 'shared'; key: string; store: CredentialStore }
  | { mode: 'chain'; sources: readonly ConcreteCredentialPlan[] };

/** A {@link CredentialPlan} that is not itself a chain. */
export type ConcreteCredentialPlan = Exclude<CredentialPlan, { mode: 'chain' }>;

/**
 * The ordered concrete plans a run should try: the chain's sources, or the
 * single plan itself.
 */
export function credentialPlanSources(
  plan: CredentialPlan,
): readonly ConcreteCredentialPlan[] {
  return plan.mode === 'chain' ? plan.sources : [plan];
}

export interface NormalizeCredentialsContext {
  /** The value of `process.env.NODE_ENV` (or equivalent). */
  nodeEnv?: string | undefined;
}

/**
 * Validate a {@link Credentials} value and resolve it to a {@link CredentialPlan}.
 *
 * @throws {CredentialError} when the configuration is unsafe for the current
 * environment (e.g. local file credentials in production) or malformed.
 */
export function normalizeCredentials(
  credentials: Credentials | undefined,
  context: NormalizeCredentialsContext = {},
): CredentialPlan {
  if (Array.isArray(credentials)) {
    const sources = credentials as readonly CredentialSource[];
    if (sources.length === 0) {
      throw new CredentialError(
        'A credentials chain needs at least one source.',
      );
    }
    const plans = sources.map((source, index) => {
      if (Array.isArray(source)) {
        throw new CredentialError(
          `credentials[${index}] is an array; chains cannot be nested.`,
        );
      }
      return normalizeSource(source, context);
    });
    const [single] = plans;
    return plans.length === 1 && single !== undefined
      ? single
      : { mode: 'chain', sources: plans };
  }
  return normalizeSource(
    (credentials ?? { type: 'env' }) as CredentialSource,
    context,
  );
}

function normalizeSource(
  value: CredentialSource,
  context: NormalizeCredentialsContext,
): ConcreteCredentialPlan {
  const isProduction = context.nodeEnv === 'production';

  if (value === 'local') {
    return assertLocalAllowed(isProduction, false, {});
  }

  switch (value.type) {
    case 'local':
      return assertLocalAllowed(
        isProduction,
        value.allowInProduction === true,
        {
          ...(value.agentDir === undefined ? {} : { agentDir: value.agentDir }),
        },
      );

    case 'env':
      return { mode: 'env' };

    case 'apiKeys': {
      const entries = Object.entries(value.keys);
      if (entries.length === 0) {
        throw new CredentialError(
          'apiKeys credentials require at least one provider key.',
        );
      }
      for (const [provider, key] of entries) {
        if (typeof key !== 'string' || key.length === 0) {
          throw new CredentialError(
            `apiKeys credential for "${provider}" must be a non-empty string.`,
          );
        }
      }
      return { mode: 'apiKeys', keys: { ...value.keys } };
    }

    case 'agentDir':
      if (typeof value.path !== 'string' || value.path.length === 0) {
        throw new CredentialError(
          'agentDir credentials require a non-empty path.',
        );
      }
      return { mode: 'agentDir', path: value.path };

    case 'shared': {
      if (typeof value.key !== 'string' || value.key.length === 0) {
        throw new CredentialError(
          'shared credentials require a non-empty key.',
        );
      }
      return { mode: 'shared', key: value.key, store: value.store };
    }
  }
}

function assertLocalAllowed(
  isProduction: boolean,
  allowInProduction: boolean,
  extra: { agentDir?: string },
): ConcreteCredentialPlan {
  if (isProduction && !allowInProduction) {
    throw new CredentialError(
      'Local file credentials are refused in production. Use { type: "env" }, ' +
        '{ type: "apiKeys" } or { type: "shared" }, or set allowInProduction: true ' +
        'to opt in explicitly.',
    );
  }
  return { mode: 'local', ...extra };
}
