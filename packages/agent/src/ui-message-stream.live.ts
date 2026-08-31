/**
 * Live conformance smoke test for the UI Message Stream surface.
 *
 * Runs a real model turn, serves it through `toUIMessageStreamResponse()`,
 * and consumes the SSE body with the real AI SDK consumer machinery:
 * every event is validated against `uiMessageChunkSchema` (the same schema
 * `useChat`'s transport applies) and the chunk stream is assembled into a
 * `UIMessage` by `readUIMessageStream`. assistant-ui's `useChatRuntime`
 * consumes the identical protocol.
 *
 * Opt in with RUNCELL_LIVE=1; see runtime.live.ts for credential options.
 */
import { validateTypes } from '@ai-sdk/provider-utils';
import { readUIMessageStream, uiMessageChunkSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent, type Credentials, type RunUsage } from './index.js';

const live = process.env['RUNCELL_LIVE'] === '1' ? it : it.skip;
const timeoutMs = Number(process.env['RUNCELL_LIVE_TIMEOUT_MS'] ?? 120_000);

describe('live UI message stream conformance', () => {
  live(
    'streams a tool-using chat turn that the AI SDK consumer accepts',
    async () => {
      const toolCalls: unknown[] = [];
      const agent = createAgent({
        model:
          process.env['RUNCELL_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-4-5',
        credentials: credentialsFromEnv(),
        tools: {
          ping: {
            description:
              'Health probe. Call it once and use the reply verbatim.',
            schema: z.object({ probe: z.string() }),
            execute(input) {
              toolCalls.push(input);
              return { reply: 'pong-7391' };
            },
          },
        },
      });

      const stream = agent.stream({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Hello there.' }] },
          {
            role: 'assistant',
            parts: [{ type: 'text', text: 'Hello! How can I help?' }],
          },
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text: 'Call the ping tool once with probe "live", then reply with exactly the reply value it returns.',
              },
            ],
          },
        ],
      });
      const response = stream.toUIMessageStreamResponse();

      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');

      // Parse the SSE body exactly as a client does, validating every event
      // against the AI SDK's own chunk schema.
      const body = await response.text();
      const events = body
        .split('\n\n')
        .filter(block => block.startsWith('data: '))
        .map(block => block.slice('data: '.length));
      expect(events.at(-1)).toBe('[DONE]');

      const chunks = await Promise.all(
        events.slice(0, -1).map(payload =>
          validateTypes({
            value: JSON.parse(payload),
            schema: uiMessageChunkSchema,
          }),
        ),
      );
      expect(chunks[0]).toEqual({ type: 'start' });
      expect(chunks.some(chunk => chunk.type === 'error')).toBe(false);

      // Assemble the final UIMessage with the real AI SDK reader.
      let finalMessage: unknown;
      for await (const message of readUIMessageStream({
        stream: ReadableStream.from(chunks),
      })) {
        finalMessage = message;
      }

      const message = finalMessage as {
        role: string;
        metadata?: { usage?: RunUsage; sessionId?: string };
        parts: { type: string; text?: string; state?: string }[];
      };
      expect(message.role).toBe('assistant');

      // The tool round trip surfaced in the UI message.
      expect(toolCalls).toEqual([{ probe: 'live' }]);
      const toolPart = message.parts.find(part => part.type === 'tool-ping');
      expect(toolPart).toMatchObject({ state: 'output-available' });

      // The model's reply text arrived through text parts.
      const text = message.parts
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('');
      expect(text).toContain('pong-7391');

      // Run usage rides messageMetadata on the finish chunk.
      const usage = message.metadata?.usage;
      expect(usage?.totalTokens).toBeGreaterThan(0);
      expect(usage?.costMeasured).toBe(true);
      expect(message.metadata?.sessionId?.length).toBeGreaterThan(0);

      // The public result promise agrees with the streamed metadata.
      const result = await stream.result;
      expect(result.usage).toEqual(usage);
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
