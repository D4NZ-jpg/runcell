import { createAgent, IncompleteResultError } from 'runcell';
import { z } from 'zod';

const triageSchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: z.string(),
  recommendedFixes: z.array(z.string()),
});

export async function triageBugReport(
  report: string,
): Promise<z.infer<typeof triageSchema>> {
  const agent = createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    credentials: { type: 'env' },
    // If the model forgets to submit valid structured output, runcell can ask
    // it to repair the answer before failing the run.
    maxRepairs: 1,
  });

  try {
    const result = await agent.run({
      prompt: 'Triage this bug report and return only the structured result.',
      files: [{ path: 'bug-report.txt', text: report }],
      schema: triageSchema,
    });

    return result.data;
  } catch (error) {
    if (error instanceof IncompleteResultError) {
      // The model never produced a valid schema payload, even after repair.
      // Treat this as an incomplete job rather than accepting prose.
      throw new Error('Bug triage did not produce valid structured output.', {
        cause: error,
      });
    }

    throw error;
  }
}
