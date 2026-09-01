/**
 * Live smoke test for the built-in readPdfPages tool: a real model receives
 * a PDF attachment through `messages`, must call readPdfPages to view the
 * rendered page, and reply with the code printed on it.
 *
 * Opt in with RUNCELL_LIVE=1; see runtime.live.ts for credential options.
 */
import { describe, expect, it } from 'vitest';
import { createAgent, type Credentials, type ToolCallEvent } from './index.js';
import { tinyPdf } from './pdf-pages.test.js';

const live = process.env['RUNCELL_LIVE'] === '1' ? it : it.skip;
const timeoutMs = Number(process.env['RUNCELL_LIVE_TIMEOUT_MS'] ?? 120_000);

describe('live readPdfPages smoke', () => {
  live(
    'a model views a PDF attachment through the built-in tool',
    async () => {
      const toolCalls: ToolCallEvent[] = [];
      const agent = createAgent({
        model:
          process.env['RUNCELL_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
        credentials: credentialsFromEnv(),
        events: { onToolCall: call => toolCalls.push(call) },
      });

      const pdfBase64 = Buffer.from(tinyPdf('CODE-8452')).toString('base64');
      const result = await agent.run({
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text:
                  'A PDF is attached. View its first page with the ' +
                  'readPdfPages tool and reply with exactly the code ' +
                  'printed on it, nothing else.',
              },
              {
                type: 'file',
                url: `data:application/pdf;base64,${pdfBase64}`,
                mediaType: 'application/pdf',
                filename: 'document.pdf',
              },
            ],
          },
        ],
      });

      expect(toolCalls.some(call => call.name === 'readPdfPages')).toBe(true);
      expect(result.text).toContain('CODE-8452');
      expect(result.usage.totalTokens).toBeGreaterThan(0);
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
