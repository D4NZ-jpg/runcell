import { createAgent, createThread, createVirtualSandbox } from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

/**
 * Multi-phase work over one shared sandbox: consecutive `agent.run` calls
 * where each phase builds on the previous one's workspace.
 *
 * - The `thread` carries the conversation, so phase 2 can say "the file you
 *   just wrote" and be understood.
 * - The `sandbox` carries the filesystem, so the file actually still exists.
 * - The caller owns the sandbox: runcell never destroys a handle you pass in,
 *   and you can inspect or exec against it between phases.
 */
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
    // ---- phase 1: produce work in the workspace ---------------------------
    const plan = await agent.run({
      prompt:
        'Write a haiku about TypeScript to haiku.txt. Then call submitResult ' +
        'with files set to the list of file paths you created. Do not stop ' +
        'after writing prose.',
      thread,
      sandbox,
      schema: z.object({ files: z.array(z.string()) }),
    });

    // ---- between phases: the caller can work the sandbox directly ---------
    const wc = await sandbox.exec('wc -w < haiku.txt');
    const wordCount = Number(wc.stdout.trim());

    // ---- phase 2: continue from phase 1's files and conversation ----------
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
