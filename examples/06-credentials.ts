import { createAgent, type Agent, type CredentialStore } from 'runcell';

export function createDefaultEnvAgent(): Agent {
  return createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    // Default: read provider credentials from process.env.
    // If your app loads `.env`, those values are used automatically.
  });
}

export function createExplicitEnvAgent(): Agent {
  return createAgent({
    model: 'openai/gpt-5.1',
    credentials: { type: 'env' },
  });
}

export function createLocalDevAgent(): Agent {
  return createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    // Optional opt-in: reuse locally configured developer credentials.
    credentials: 'local',
  });
}

export function createExplicitApiKeyAgent(apiKey: string): Agent {
  return createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    // Useful when your app already fetched the secret from its own vault.
    credentials: {
      type: 'apiKeys',
      keys: { anthropic: apiKey },
    },
  });
}

export function createSharedOauthAgent(store: CredentialStore): Agent {
  return createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    // For OAuth in multi-instance production deployments. The store must be
    // durable and lockable so token refreshes are visible across instances.
    credentials: {
      type: 'shared',
      key: 'prod-agent-default',
      store,
    },
  });
}
