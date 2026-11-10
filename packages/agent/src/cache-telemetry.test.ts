import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type TranscriptContext,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { streamSimple as codexStream } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { createAgent } from './create-agent.js';
import { createThread } from './thread.js';
import type { ModelRequestEvent } from './types.js';

// Real SDK/session/runtime, synthetic provider responses. No credentials or HTTP.
describe('offline cache identity and telemetry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves all context and reasoning while stabilizing the actual Codex cache key', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Network forbidden in offline test');
    });
    vi.stubGlobal('fetch', fetch);
    const captures: {
      context: TranscriptContext;
      options: SimpleStreamOptions;
    }[] = [];
    const observations: ModelRequestEvent[] = [];
    const agent = createAgent({
      model: 'cache-test/offline',
      credentials: { type: 'apiKeys', keys: { 'cache-test': 'offline-dummy' } },
      events: { onModelRequest: event => observations.push(event) },
      pi: {
        extensions: [
          pi => {
            pi.registerProvider('cache-test', {
              baseUrl: 'http://invalid.invalid',
              apiKey: 'offline-dummy',
              api: 'openai-responses',
              models: [
                {
                  id: 'offline',
                  name: 'Offline',
                  input: ['text'],
                  reasoning: true,
                  contextWindow: 2_000_000,
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
              streamSimple(model, context, options) {
                captures.push({
                  context: structuredClone(context),
                  options: { ...options },
                });
                const message: AssistantMessage = {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'OK' }],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  timestamp: Date.now(),
                  stopReason: 'stop',
                  usage: {
                    input: 11,
                    output: 7,
                    cacheRead: 5,
                    cacheWrite: 3,
                    totalTokens: 26,
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                      total: 0,
                    },
                  },
                };
                const stream = createAssistantMessageEventStream();
                stream.push({ type: 'start', partial: message });
                stream.push({
                  type: 'text_delta',
                  contentIndex: 0,
                  delta: 'OK',
                  partial: message,
                });
                stream.push({ type: 'done', reason: 'stop', message });
                stream.end();
                return stream;
              },
            });
          },
        ],
      },
    });
    const history = [
      { role: 'user' as const, content: 'PRESERVE_EARLIER_TURN' },
      { role: 'assistant' as const, content: 'PRESERVE_EARLIER_ANSWER' },
      { role: 'user' as const, content: 'PRESERVE_NEW_TURN' },
    ];
    const first = await agent.run({
      messages: history,
      conversationId: 'tenant:one',
      timeoutMs: 15000,
    });
    await agent.run({
      messages: history,
      conversationId: 'tenant:one',
      timeoutMs: 15000,
    });
    await agent.run({
      messages: history,
      conversationId: 'tenant:two',
      timeoutMs: 15000,
    });
    expect(captures).toHaveLength(3);
    expect(observations).toHaveLength(3);
    expect(observations[0]?.usage).toEqual(first.usage);
    expect(first.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      totalTokens: 26,
    });
    expect(captures[0]?.options.sessionId).toBe(captures[1]?.options.sessionId);
    expect(captures[0]?.options.sessionId).not.toBe(
      captures[2]?.options.sessionId,
    );
    for (const capture of captures) {
      expect(capture.options.reasoning).toBe('medium');
      for (const marker of [
        'PRESERVE_EARLIER_TURN',
        'PRESERVE_EARLIER_ANSWER',
        'PRESERVE_NEW_TURN',
      ]) {
        expect(JSON.stringify(capture.context.messages)).toContain(marker);
      }
    }
    const codexModel = openaiCodexProvider().getModels()[0];
    assert.ok(codexModel);
    const captureAt = (index: number) => {
      const capture = captures[index];
      assert.ok(capture);
      return capture;
    };
    // Fabricated JWT: the payload hook stops the real wire builder before fetch.
    const apiKey =
      'fake.' +
      Buffer.from(
        JSON.stringify({
          'https://api.openai.com/auth': { chatgpt_account_id: 'offline-test' },
        }),
      ).toString('base64url') +
      '.fake';
    const wire = async (capture: (typeof captures)[number]) => {
      let payload: Record<string, unknown> | undefined;
      const result = await codexStream(codexModel, capture.context, {
        apiKey,
        sessionId: capture.options.sessionId,
        reasoning: capture.options.reasoning,
        onPayload: value => {
          payload = value as Record<string, unknown>;
          throw new Error('Stop before HTTP');
        },
      }).result();
      expect(result.errorMessage).toContain('Stop before HTTP');
      assert.ok(payload);
      return payload;
    };
    const a = await wire(captureAt(0));
    const b = await wire(captureAt(1));
    const c = await wire(captureAt(2));
    expect(a['prompt_cache_key']).toBe(b['prompt_cache_key']);
    expect(a['prompt_cache_key']).not.toBe(c['prompt_cache_key']);
    expect(a['reasoning']).toEqual(b['reasoning']);

    const thread = createThread();
    await agent.run({
      prompt: 'NATIVE_HISTORY_MARKER',
      thread,
      timeoutMs: 15000,
    });
    await agent.run({
      prompt: 'follow up',
      thread,
      conversationId: 'cannot-replace-native-id',
      timeoutMs: 15000,
    });
    expect(captures[3]?.options.sessionId).toBe(captures[4]?.options.sessionId);
    const resumed = await wire(captureAt(4));
    const initial = await wire(captureAt(3));
    expect(resumed['prompt_cache_key']).toBe(initial['prompt_cache_key']);
    expect(resumed['instructions']).toBe(initial['instructions']);
    expect(
      JSON.stringify(captures[4]?.context.messages).split(
        'NATIVE_HISTORY_MARKER',
      ),
    ).toHaveLength(2);
    expect(getCurrentSystemPrompt(captureAt(4).context.messages)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  }, 60000);
});
