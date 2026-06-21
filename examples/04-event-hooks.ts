import { createAgent } from 'runcell';
import { z } from 'zod';

const planSchema = z.object({
  plan: z.array(z.string()),
});

export async function runWithEventHooks(): Promise<z.infer<typeof planSchema>> {
  const agent = createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    credentials: { type: 'env' },
    events: {
      // Stream model text to your UI/log sink.
      onText: text => process.stdout.write(text),

      // Observe tools and file changes for progress UIs or audit logs.
      onToolCall: call => process.stderr.write(`\ncalling ${call.name}\n`),
      onToolResult: result => process.stderr.write(`finished ${result.name}\n`),
      onFileChange: file => process.stderr.write(`changed ${file.path}\n`),

      // Repairs happen when the structured output contract is missing/invalid.
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
