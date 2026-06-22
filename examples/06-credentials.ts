import { createAgent, type Agent, type CredentialStore } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const credentialExampleSchema = z.object({
  credentialMode: z.string(),
  ready: z.literal(true),
});

export function createDefaultLocalAgent(): Agent {
  return createAgent({
    model: exampleModel(),
    credentials: 'local',
  });
}

export function createEnvAgent(): Agent {
  return createAgent({
    model: exampleModel(),
    credentials: { type: 'env' },
  });
}

export function createExplicitApiKeyAgent(apiKey: string): Agent {
  return createAgent({
    model: exampleModel(),
    credentials: {
      type: 'apiKeys',
      keys: { anthropic: apiKey },
    },
  });
}

export function createSharedOauthAgent(store: CredentialStore): Agent {
  return createAgent({
    model: exampleModel(),
    credentials: {
      type: 'shared',
      key: 'prod-agent-default',
      store,
    },
  });
}

export async function runCredentialsExample(): Promise<
  z.infer<typeof credentialExampleSchema>
> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
  });

  const result = await agent.run({
    prompt:
      'Return credentialMode as "local-dev" and ready as true. Do not include secrets.',
    schema: credentialExampleSchema,
  });

  return result.data;
}

runExample(import.meta.url, runCredentialsExample);
