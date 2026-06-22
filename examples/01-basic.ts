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
        text: 'runcell runs AI agents in an isolated sandbox cell. It accepts files, host tools, event callbacks, and a Zod schema. The agent must submit its final structured result through a hidden submitResult tool.',
      },
    ],
    schema: summarySchema,
  });

  return result.data;
}

runExample(import.meta.url, runBasicExample);
