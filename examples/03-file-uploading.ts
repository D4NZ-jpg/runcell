import { readFile } from 'node:fs/promises';
import { createAgent } from 'runcell';
import { z } from 'zod';

const auditSchema = z.object({
  codeSummary: z.string(),
  invoiceTotal: z.string().optional(),
  screenshotFindings: z.array(z.string()),
});

export async function analyzeUploadedFiles(paths: {
  sourceFile: string;
  invoicePdf: string;
  screenshotPng: string;
}): Promise<z.infer<typeof auditSchema>> {
  const [source, invoicePdf, screenshotPng] = await Promise.all([
    readFile(paths.sourceFile, 'utf8'),
    readFile(paths.invoicePdf),
    readFile(paths.screenshotPng),
  ]);

  const agent = createAgent({
    model: 'anthropic/claude-sonnet-4-5',
    credentials: { type: 'env' },
  });

  const result = await agent.run({
    prompt: 'Review the source file, invoice PDF, and screenshot.',
    files: [
      { path: 'src/index.ts', text: source },
      {
        path: 'invoice.pdf',
        bytes: invoicePdf,
        mediaType: 'application/pdf',
      },
      {
        path: 'screenshot.png',
        bytes: screenshotPng,
        mediaType: 'image/png',
      },
    ],
    schema: auditSchema,
  });

  return result.data;
}
