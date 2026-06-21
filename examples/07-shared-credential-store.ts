import type { AuthBlob, CredentialStore } from 'runcell';

/**
 * Minimal local/test store showing the CredentialStore shape.
 *
 * Production should use durable shared storage plus a real distributed lock
 * (for example Postgres advisory locks, Redis locks, or DynamoDB conditionals).
 */
export function createInMemoryCredentialStore(
  initial?: AuthBlob,
): CredentialStore {
  let current = initial;
  let locked = false;

  return {
    async withLock(key, fn) {
      if (locked) {
        throw new Error(`Credential store is already locked for ${key}.`);
      }

      locked = true;
      try {
        const { result, next } = await fn(current);
        if (next !== undefined) {
          current = next;
        }
        return result;
      } finally {
        locked = false;
      }
    },
  };
}
