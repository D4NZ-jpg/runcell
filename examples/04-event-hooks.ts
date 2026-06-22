import { createAgent } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const planSchema = z.object({
  plan: z.array(z.string()),
});

export async function runWithEventHooks(): Promise<z.infer<typeof planSchema>> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    events: {
      onText: text => process.stdout.write(text),
      onToolCall: call => process.stderr.write(`\ncalling ${call.name}\n`),
      onToolResult: result => process.stderr.write(`finished ${result.name}\n`),
      onFileChange: file => process.stderr.write(`changed ${file.path}\n`),
      onRepair: repair =>
        process.stderr.write(`repair #${repair.attempt}: ${repair.reason}\n`),
    },
  });

  const result = await agent.run({
    prompt: 'Create a concise implementation plan for adding a login page.',
    schema: planSchema,
  });

  return result.data;
}

runExample(import.meta.url, runWithEventHooks);
