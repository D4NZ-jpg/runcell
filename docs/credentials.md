# Credentials

Runcell agents authenticate two ways: with an AI subscription you already pay
for, or with provider API keys. Subscriptions are the fastest way to run your
first agent; API keys are the path for production.

## Use your subscription

`credentials: 'local'` runs agents on the provider logins stored on your
machine — no API key required. Supported subscription logins:

- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

Runcell bundles the Pi engine, so its CLI is already in your project. Log in
once:

```bash
npx pi     # then type /login and pick your provider
```

The browser opens, you sign in, and the OAuth tokens land in
`~/.pi/agent/auth.json`. From then on:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});
```

Runcell refreshes the tokens automatically. `result.usage.costUsd` still
reports what each run would have cost through the provider's API, so costs
stay observable on a flat-rate subscription (see
[`RunUsage`](./api.md#runusage)).

Provider terms govern subscription use, and they differ per provider and
change over time — review yours before relying on it. Individual use of your
own subscription is the commonly accepted pattern (Anthropic has publicly
said as much); API keys are the provider-supported path for deployed and
commercial work. For that reason `'local'` is refused when `NODE_ENV` is
`production` unless you opt in explicitly — for example, a remote test box
running under your own account:

```ts
credentials: { type: 'local', allowInProduction: true }
```

## Default behavior: environment variables

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
a lockable store. The official Postgres implementation is
[`@runcell/postgres-credentials`](https://www.npmjs.com/package/@runcell/postgres-credentials):

```ts
import pg from 'pg';
import { createPostgresCredentialStore } from '@runcell/postgres-credentials';

const store = createPostgresCredentialStore({
  pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  encryptionKey: process.env.CREDENTIAL_STORE_SECRET, // optional, at-rest encryption
});
```

It serializes concurrent refreshes across deployments on a Postgres row lock,
so a rotated token is never clobbered. To back the store with something else,
implement the interface yourself:

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
