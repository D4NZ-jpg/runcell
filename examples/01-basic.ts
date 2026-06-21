import { createAgent } from 'runcell';
import { z } from 'zod';

const summarySchema = z.object({
  summary: z.string(),
  nextSteps: z.array(z.string()),
});

export async function runBasicExample(): Promise<
  z.infer<typeof summarySchema>
> {
  const agent = createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    // Credentials default to environment variables, so loading a .env file in
    // your app is enough for local development.
  });

  const result = await agent.run({
    prompt: 'Summarize what runcell is for in three bullets.',
    schema: summarySchema,
  });

  // `data` is the validated, typed output. `text` is just streamed prose.
  return result.data;
}
