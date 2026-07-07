import { createAgent } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const summarySchema = z.object({
  summary: z.string(),
  nextSteps: z.array(z.string()),
});

export async function runBasicExample(): Promise<
  z.infer<typeof summarySchema>
> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
  });

  const result = await agent.run({
    prompt:
      'Read runcell.txt and summarize what runcell is for in three short bullets.',
    files: [
      {
        path: 'runcell.txt',
        text: 'runcell lets you build AI agents in TypeScript that return typed, validated data. Each run is sandboxed and accepts files, host tools, event callbacks, and a schema. The agent submits its final structured result through a hidden submitResult tool.',
      },
    ],
    schema: summarySchema,
  });

  return result.data;
}

runExample(import.meta.url, runBasicExample);
