import { createAgent, IncompleteResultError } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const triageSchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: z.string(),
  recommendedFixes: z.array(z.string()),
});

const sampleReport = `
Checkout intermittently returns HTTP 500 after a deployment. The error rate is
around 18% for card payments, and logs show connection pool exhaustion.
`;

export async function triageBugReport(
  report = sampleReport,
): Promise<z.infer<typeof triageSchema>> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    maxRepairs: 1,
  });

  try {
    const result = await agent.run({
      prompt: 'Triage this bug report and return the structured result.',
      files: [{ path: 'bug-report.txt', text: report }],
      schema: triageSchema,
    });

    return result.data;
  } catch (error) {
    if (error instanceof IncompleteResultError) {
      throw new Error('Bug triage did not produce valid structured output.', {
        cause: error,
      });
    }
    throw error;
  }
}

runExample(import.meta.url, () => triageBugReport());
