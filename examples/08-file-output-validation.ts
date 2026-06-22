import { createAgent, type ChangedFile } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const reportSchema = z.object({
  title: z.string(),
  reportPath: z.literal('report.md'),
  findingCount: z.number().int().nonnegative(),
  keyFindings: z.array(z.string()).min(1),
});

const validatedRunSchema = z.object({
  data: reportSchema,
  file: z.object({
    path: z.literal('report.md'),
    text: z.string().min(1),
  }),
  finishReason: z.string().min(1),
});

const feedback = `
Users like the new onboarding checklist, but several asked for a shorter first
screen. Three enterprise customers also asked for CSV export and clearer error
messages when imports fail.
`;

export async function runFileOutputValidationExample(): Promise<
  z.infer<typeof validatedRunSchema>
> {
  let finishReason: string | undefined;
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    maxRepairs: 2,
    events: {
      onFinish: event => {
        finishReason = event.finishReason;
      },
    },
  });

  const result = await agent.run({
    prompt:
      'Read feedback.txt. Create report.md with a concise markdown report. Then call submitResult with title, reportPath "report.md", findingCount, and keyFindings.',
    files: [{ path: 'feedback.txt', text: feedback }],
    schema: reportSchema,
  });

  return validateRunOutput({
    data: result.data,
    files: result.files,
    finishReason,
  });
}

function validateRunOutput({
  data,
  files,
  finishReason,
}: {
  data: z.infer<typeof reportSchema>;
  files: ChangedFile[];
  finishReason: string | undefined;
}): z.infer<typeof validatedRunSchema> {
  const file = files.find(candidate => candidate.path === data.reportPath);
  const text = file ? new TextDecoder().decode(file.bytes) : '';
  return validatedRunSchema.parse({
    data,
    file: file ? { path: file.path, text } : undefined,
    finishReason,
  });
}

runExample(import.meta.url, runFileOutputValidationExample);
