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
returns the updated blob when tokens rotate.

```ts
const store: CredentialStore = {
  async withLock(key, fn) {
    const current = await loadCredentialBlob(key);
    const { result, next } = await fn(current);
    if (next) {
      await saveCredentialBlob(key, next);
    }
    return result;
  },
};
```

See `examples/07-shared-credential-store.ts` for a minimal in-memory shape.
