import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent, type ChangedFile, type Credentials } from './index.js';

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
