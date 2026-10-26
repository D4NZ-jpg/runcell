import { InvalidOptionError } from './errors.js';
import type { RunContext } from './types.js';

/** Validate and copy only inert, JSON-safe application attributes. */
export function snapshotRunContext(value: unknown): RunContext | undefined {
  if (value === undefined) return undefined;
  const message =
    'run "context" must be a plain object of strings, finite numbers, booleans, or null.';
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidOptionError(message);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidOptionError(message);
    }
    const entries: [string, string | number | boolean | null][] = [];
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable) continue;
      const item: unknown = descriptor.value;
      if (
        !('value' in descriptor) ||
        !(
          item === null ||
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))
        )
      ) {
        throw new InvalidOptionError(message);
      }
      entries.push([key, item]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } catch (error) {
    if (error instanceof InvalidOptionError) throw error;
    throw new InvalidOptionError(message, { cause: error });
  }
}
