import type { AuthBlob, CredentialStore } from 'runcell';
import { runExample } from './_shared.js';

export function createInMemoryCredentialStore(
  initial?: AuthBlob,
): CredentialStore {
  let current = initial;
  let tail = Promise.resolve();

  return {
    async withLock(_key, fn) {
      // Pi may acquire the store concurrently for multiple providers, so lock
      // implementations must queue waiters rather than reject them.
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;

      try {
        const { result, next } = await fn(current);
        if (next !== undefined) {
          current = next;
        }
        return result;
      } finally {
        release();
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
