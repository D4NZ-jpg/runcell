import type { AuthBlob, CredentialStore } from 'runcell';
import { runExample } from './_shared.js';

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

export async function runSharedCredentialStoreExample(): Promise<{
  before: string[];
  after: string[];
}> {
  const store = createInMemoryCredentialStore({
    anthropic: { type: 'api_key', key: 'example-key' },
  });

  return store.withLock('demo-agent', current =>
    Promise.resolve({
      result: {
        before: Object.keys(current ?? {}),
        after: ['anthropic', 'openai'],
      },
      next: {
        ...(current ?? {}),
        openai: { type: 'api_key', key: 'example-openai-key' },
      },
    }),
  );
}

runExample(import.meta.url, runSharedCredentialStoreExample);
