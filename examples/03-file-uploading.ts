import { createAgent } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

const auditSchema = z.object({
  codeSummary: z.string(),
  invoiceTotal: z.string(),
  screenshotFindings: z.array(z.string()),
});

const source = `
export function calculateTotal(items: Array<{ price: number; quantity: number }>): number {
  return items.reduce((total, item) => total + item.price * item.quantity, 0);
}
`;

const invoice = `
Invoice #1007
Subtotal: $38.00
Tax: $4.50
Total: $42.50
`;

const screenshotNotes = `
Screenshot notes: the checkout page shows a green success banner and a total of $42.50.
`;

export async function analyzeUploadedFiles(): Promise<
  z.infer<typeof auditSchema>
> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    maxRepairs: 2,
  });

  const result = await agent.run({
    prompt:
      'Read src/index.ts, invoice.txt, and screenshot-notes.txt. Then call submitResult with codeSummary, invoiceTotal, and screenshotFindings. Do not stop after writing prose.',
    files: [
      { path: 'src/index.ts', text: source },
      { path: 'invoice.txt', text: invoice },
      { path: 'screenshot-notes.txt', text: screenshotNotes },
    ],
    schema: auditSchema,
  });

  return result.data;
}

runExample(import.meta.url, analyzeUploadedFiles);
