import {
  createAgent,
  createVirtualSandbox,
  createThread,
  threadFromJSON,
} from 'runcell';
import { z } from 'zod';
import { exampleCredentials, exampleModel, runExample } from './_shared.js';

/**
 * The chat-agent pattern from docs/chat-agent.md, condensed into one script:
 *
 * 1. a streamed chat turn (no schema — the text IS the reply);
 * 2. thread persistence: serialize to JSON and rebuild, like a server would
 *    between requests;
 * 3. a second turn that proves the conversation memory survived;
 * 4. a structured turn on the same thread;
 * 5. a caller-owned sandbox shared across all turns, read directly at the end.
 */
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
    // ---- turn 1: a streamed chat turn ------------------------------------
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

    // ---- persistence round-trip, like a server between requests ----------
    const savedThread = JSON.stringify(thread.toJSON());
    const revived = threadFromJSON(
      JSON.parse(savedThread) as ReturnType<typeof thread.toJSON>,
    );

    // ---- turn 2: memory survived the round-trip ---------------------------
    const second = await agent.run({
      prompt: 'What is the project codename? Answer in one short sentence.',
      thread: revived,
      sandbox,
    });

    // ---- turn 3: a structured turn on the same conversation ---------------
    const extracted = await agent.run({
      prompt: 'Call submitResult with the project codename we discussed.',
      thread: revived,
      sandbox,
      schema: z.object({ codename: z.string() }),
    });

    // ---- the caller-owned sandbox is directly readable --------------------
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
