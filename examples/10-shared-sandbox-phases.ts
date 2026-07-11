import { createAgent, createThread, createVirtualSandbox } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

/** Demonstrates consecutive runs that share a thread and caller-owned sandbox. */
export async function runSharedSandboxPhases(): Promise<{
  planned: string[];
  wordCount: number;
  report: string | null;
}> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
    maxRepairs: 2,
  });

  const thread = createThread();
  const sandbox = await createVirtualSandbox();
  try {
    // Create the file.
    const plan = await agent.run({
      prompt:
        'Write a haiku about TypeScript to haiku.txt. Then call submitResult ' +
        'with files set to the list of file paths you created. Do not stop ' +
        'after writing prose.',
      thread,
      sandbox,
      schema: z.object({ files: z.array(z.string()) }),
    });

    // Inspect it between runs.
    const wc = await sandbox.exec('wc -w < haiku.txt');
    const wordCount = Number(wc.stdout.trim());

    // Continue with the same thread and sandbox.
    await agent.run({
      prompt:
        `The haiku you just wrote is ${wordCount} words. Write REPORT.md ` +
        'containing the haiku followed by a one-line critique of it.',
      thread,
      sandbox,
    });

    const report = await sandbox.readTextFile('REPORT.md');
    return { planned: plan.data.files, wordCount, report };
  } finally {
    await sandbox.destroy();
  }
}

runExample(import.meta.url, runSharedSandboxPhases);
