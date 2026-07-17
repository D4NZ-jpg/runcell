import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash';
import { shellQuote } from './shell.js';

/*
 * just-bash (the emulated bash behind the virtual sandbox) ignores the
 * per-run `env` option entirely: variables passed that way are invisible to
 * `$VAR` expansion and to the `env` builtin inside `bash -c`. That silently
 * breaks callers that rely on it — most importantly the harness's session
 * bootstrap, which runs `mkdir -p "$WORK_DIR"` with `env: { WORK_DIR }`; the
 * variable expands to nothing, `mkdir -p ""` no-ops with exit 0, and every
 * subsequent `cd` into the session workspace fails.
 *
 * Until that is fixed upstream, this wrapper rewrites `run`/`spawn` commands
 * to inline the env as `export KEY='value'` prefixes — plain `export` works
 * correctly in just-bash. Everything else on the provider and its sessions is
 * passed through untouched.
 */

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function inlineEnv(
  command: string,
  env: Record<string, string> | undefined,
): string {
  if (!env) return command;
  const exports = Object.entries(env)
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  if (exports.length === 0) return command;
  return `${exports.join('; ')}; ${command}`;
}

interface RunLikeOptions {
  command: string;
  env?: Record<string, string>;
}

/**
 * Wrap any object whose `run`/`spawn` take `{ command, env }` so the env is
 * inlined into the command. Recurses through `restricted()` so the reduced
 * session view gets the same treatment. Implemented as a Proxy because the
 * session surface (readonly props, optional capabilities) varies by provider
 * version — explicit delegation would silently drop members on upgrades.
 */
function withInlinedEnv<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'run' || prop === 'spawn') {
        const original = Reflect.get(obj, prop) as
          | ((options: RunLikeOptions) => unknown)
          | undefined;
        if (typeof original !== 'function') return original;
        return (options: RunLikeOptions) =>
          original.call(obj, {
            ...options,
            command: inlineEnv(options.command, options.env),
          });
      }
      if (prop === 'restricted') {
        const original = Reflect.get(obj, prop) as (() => object) | undefined;
        if (typeof original !== 'function') return original;
        return () => withInlinedEnv(original.call(obj));
      }
      const value: unknown = Reflect.get(obj, prop, receiver);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(obj)
        : value;
    },
  });
}

/**
 * `createJustBashSandbox` with the env-inlining workaround applied to every
 * session it creates. Drop-in replacement for the upstream factory.
 */
export function createPatchedJustBashSandbox(
  ...args: Parameters<typeof createJustBashSandbox>
): ReturnType<typeof createJustBashSandbox> {
  const provider = createJustBashSandbox(...args);
  return new Proxy(provider, {
    get(obj, prop, receiver) {
      if (prop === 'createSession' || prop === 'resume') {
        const original = Reflect.get(obj, prop) as
          | ((...fnArgs: unknown[]) => Promise<object>)
          | undefined;
        if (typeof original !== 'function') return original;
        return async (...fnArgs: unknown[]) =>
          withInlinedEnv(await original.apply(obj, fnArgs));
      }
      const value: unknown = Reflect.get(obj, prop, receiver);
      return typeof value === 'function'
        ? (value as (...fnArgs: unknown[]) => unknown).bind(obj)
        : value;
    },
  });
}
