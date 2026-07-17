# Credentials

`runcell` separates local development credentials from production credential
configuration.

## Default behavior

When `credentials` is omitted, `runcell` uses environment variables:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
});
```

This is equivalent to:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: { type: 'env' },
});
```

## Local development

Examples default to local credentials:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});
```

This is convenient for a configured development machine. In production,
`local` credentials are refused unless explicitly allowed.

## Explicit API keys

Use this when your application already loaded secrets from its own vault or
configuration layer:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: {
    type: 'apiKeys',
    keys: {
      anthropic: process.env.ANTHROPIC_API_KEY!,
    },
  },
});
```

## Explicit credential directory

Use a specific local credential directory:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: { type: 'agentDir', path: '/path/to/agent-dir' },
});
```

## Shared credential store

For deployments that need shared OAuth state or refreshable credentials, provide
a lockable store:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: {
    type: 'shared',
    key: 'prod-agent-default',
    store,
  },
});
```

A `CredentialStore` implementation receives the current credential blob and
returns the updated blob when tokens rotate. Pi may read credentials for
multiple providers in parallel, so concurrent `withLock` calls for the same key
**must wait in a queue**. Do not reject a call merely because another caller
holds the lock.

```ts
type StoredCredential =
  | {
      type: 'api_key';
      key?: string;
      env?: Record<string, string>;
    }
  | {
      type: 'oauth';
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

type AuthBlob = Record<string, StoredCredential>;
```

The optional API-key `key` supports keyless or environment-backed providers
such as Bedrock. OAuth entries may include provider-specific fields such as
`accountId`.

```ts
const store: CredentialStore = {
  async withLock(key, fn) {
    // Acquire a queueing lock for this key before reading or updating it.
    return queueFor(key, async () => {
      const current = await loadCredentialBlob(key);
      const { result, next } = await fn(current);
      if (next !== undefined) {
        await saveCredentialBlob(key, next);
      }
      return result;
    });
  },
};
```

See `examples/07-shared-credential-store.ts` for a minimal in-memory queue.
