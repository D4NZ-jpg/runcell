import {
  createAgent,
  createVirtualSandbox,
  createThread,
  threadFromJSON,
} from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

/** Demonstrates streaming, persisted threads, structured output, and sandbox reuse. */
export async function runChatAgent(): Promise<{
  firstReply: string;
  secondReply: string;
  codename: string;
  notes: string | null;
  turnsRecorded: number;
}> {
  const agent = createAgent({
    model: exampleModel(),
    credentials: exampleCredentials(),
  });

  const sandbox = await createVirtualSandbox();
  try {
    // Stream the first turn.
    const thread = createThread({ id: 'demo-conversation' });
    const first = agent.stream({
      prompt:
        'Remember: the project codename is Aurora. Create a file NOTES.md ' +
        'containing exactly "codename: Aurora". Then reply with one short ' +
        'confirmation sentence.',
      thread,
      sandbox,
    });
    for await (const delta of first.textStream) {
      process.stdout.write(delta);
    }
    process.stdout.write('\n');
    const firstResult = await first.result;

    // Serialize and restore the thread.
    const savedThread = JSON.stringify(thread.toJSON());
    const revived = threadFromJSON(
      JSON.parse(savedThread) as ReturnType<typeof thread.toJSON>,
    );

    // Continue the restored thread.
    const second = await agent.run({
      prompt: 'What is the project codename? Answer in one short sentence.',
      thread: revived,
      sandbox,
    });

    // Request structured output.
    const extracted = await agent.run({
      prompt: 'Call submitResult with the project codename we discussed.',
      thread: revived,
      sandbox,
      schema: z.object({ codename: z.string() }),
    });

    // Read the generated file.
    const notes = await sandbox.readTextFile('NOTES.md');

    return {
      firstReply: firstResult.text.trim(),
      secondReply: second.text.trim(),
      codename: extracted.data.codename,
      notes: notes?.trim() ?? null,
      turnsRecorded: revived.messages.length,
    };
  } finally {
    await sandbox.destroy();
  }
}

runExample(import.meta.url, runChatAgent);
