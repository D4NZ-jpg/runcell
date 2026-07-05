import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  createThread,
  createVirtualSandbox,
  type ChangedFile,
  type Credentials,
} from './index.js';

const live = process.env['RUNCELL_LIVE'] === '1' ? it : it.skip;
const timeoutMs = Number(process.env['RUNCELL_LIVE_TIMEOUT_MS'] ?? 120_000);

describe('live runtime smoke', () => {
  live(
    'runs against a real model and sandbox',
    async () => {
      const schema = z.object({
        ok: z.literal(true),
        code: z.literal('runcell-live-smoke'),
      });
      const fileChanges: ChangedFile[] = [];
      const agent = createAgent({
        model:
          process.env['RUNCELL_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
        credentials: credentialsFromEnv(),
        events: {
          onFileChange: file => fileChanges.push(file),
        },
      });

      const result = await agent.run({
        prompt:
          'Read input.txt. Create output.txt containing exactly "hello from sandbox" with no extra newline. Then call submitResult with ok true and code equal to the exact input.txt contents.',
        files: [{ path: 'input.txt', text: 'runcell-live-smoke' }],
        schema,
      });

      expect(result.data).toEqual({
        ok: true,
        code: 'runcell-live-smoke',
      });
      expect(result.sessionId.length).toBeGreaterThan(0);

      const outputFile = result.files.find(file => file.path === 'output.txt');
      expect(outputFile).toMatchObject({
        path: 'output.txt',
        change: 'create',
      });
      expect(new TextDecoder().decode(outputFile?.bytes).trim()).toBe(
        'hello from sandbox',
      );
      expect(fileChanges.some(file => file.path === 'output.txt')).toBe(true);
    },
    timeoutMs,
  );

  live(
    'reuses a caller-owned sandbox across runs without destroying it',
    async () => {
      const agent = createAgent({
        model:
          process.env['RUNCELL_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
        credentials: credentialsFromEnv(),
      });
      const sandbox = await createVirtualSandbox();
      try {
        const first = await agent.run({
          prompt:
            'Create a file named memo.txt containing exactly "runcell-reuse" with no extra newline, then call submitResult with done true.',
          schema: z.object({ done: z.literal(true) }),
          sandbox,
        });
        expect(first.data.done).toBe(true);

        // The caller-owned handle sees exactly what the agent wrote.
        expect((await sandbox.readTextFile('memo.txt'))?.trim()).toBe(
          'runcell-reuse',
        );

        // A second run on the same handle sees the first run's files.
        const second = await agent.run({
          prompt:
            'Read memo.txt and call submitResult with contents set to its exact trimmed text.',
          schema: z.object({ contents: z.string() }),
          sandbox,
        });
        expect(second.data.contents.trim()).toBe('runcell-reuse');

        // Still alive after both runs: runcell never destroyed it.
        expect((await sandbox.exec('echo ok')).stdout.trim()).toBe('ok');
      } finally {
        await sandbox.destroy();
      }
    },
    timeoutMs,
  );

  live(
    'remembers earlier turns through a thread',
    async () => {
      const agent = createAgent({
        model:
          process.env['RUNCELL_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
        credentials: credentialsFromEnv(),
      });
      const sandbox = await createVirtualSandbox();
      const thread = createThread();
      try {
        await agent.run({
          prompt:
            'Remember that the secret word is "banana". Call submitResult with acknowledged set to true.',
          schema: z.object({ acknowledged: z.literal(true) }),
          sandbox,
          thread,
        });

        const recalled = await agent.run({
          prompt:
            'What was the secret word I told you? Call submitResult with word set to exactly that word.',
          schema: z.object({ word: z.string() }),
          sandbox,
          thread,
        });
        expect(recalled.data.word.toLowerCase()).toContain('banana');

        // The thread accumulated both turns for portable persistence.
        expect(thread.messages).toHaveLength(4);
      } finally {
        await sandbox.destroy();
      }
    },
    timeoutMs,
  );
});

function credentialsFromEnv(): Credentials {
  const value = process.env['RUNCELL_LIVE_CREDENTIALS'] ?? 'local';
  if (value === 'local') {
    return 'local';
  }
  if (value === 'env') {
    return { type: 'env' };
  }
  if (value.startsWith('agentDir:')) {
    return { type: 'agentDir', path: value.slice('agentDir:'.length) };
  }
  throw new Error(
    'RUNCELL_LIVE_CREDENTIALS must be local, env, or agentDir:/path.',
  );
}
