import { describe, expect, it } from 'vitest';
import { TurnError } from './errors.js';
import type { RunResult, RunUsage } from './types.js';
import {
  createUIMessageChunkConverter,
  uiChatMessagesToPrompt,
  uiChatMessageText,
  uiMessageChunksToResponse,
} from './ui-message-stream.js';
import type { UIMessageChunk } from './types.js';

async function* toAsyncIterable(
  chunks: readonly UIMessageChunk[],
): AsyncIterable<UIMessageChunk> {
  await Promise.resolve();
  for (const chunk of chunks) {
    yield chunk;
  }
}

const usage: RunUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  totalTokens: 18,
  costUsd: 0.02,
  costMeasured: true,
};

function runResult(
  overrides: Partial<RunResult<unknown>> = {},
): RunResult<unknown> {
  return {
    data: undefined,
    text: 'hi',
    files: [],
    finishReason: 'stop',
    sessionId: 'session-1',
    usage,
    ...overrides,
  };
}

describe('createUIMessageChunkConverter', () => {
  it('maps a plain text turn onto one message with one step', () => {
    const converter = createUIMessageChunkConverter();
    const chunks = [
      ...converter.handlePart({ type: 'text-start', id: 't1' }),
      ...converter.handlePart({ type: 'text-delta', id: 't1', text: 'hel' }),
      ...converter.handlePart({ type: 'text-delta', id: 't1', text: 'lo' }),
      ...converter.handlePart({ type: 'text-end', id: 't1' }),
      ...converter.handlePart({ type: 'finish', finishReason: 'stop' }),
      ...converter.finish(runResult()),
    ];

    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'hel' },
      { type: 'text-delta', id: 't1', delta: 'lo' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      {
        type: 'finish',
        messageMetadata: { usage, sessionId: 'session-1' },
      },
    ]);
  });

  it('maps reasoning blocks and tool calls, closing open text first', () => {
    const converter = createUIMessageChunkConverter();
    const chunks = [
      ...converter.handlePart({ type: 'reasoning-start', id: 'r1' }),
      ...converter.handlePart({
        type: 'reasoning-delta',
        id: 'r1',
        text: 'thinking',
      }),
      ...converter.handlePart({ type: 'reasoning-end', id: 'r1' }),
      ...converter.handlePart({ type: 'text-start', id: 't1' }),
      ...converter.handlePart({ type: 'text-delta', id: 't1', text: 'using' }),
      ...converter.handlePart({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'weather',
        input: { city: 'lima' },
      }),
      ...converter.handlePart({
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: { tempC: 18 },
      }),
    ];

    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'using' },
      { type: 'text-end', id: 't1' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'weather',
        input: { city: 'lima' },
      },
      {
        type: 'tool-output-available',
        toolCallId: 'call-1',
        output: { tempC: 18 },
      },
    ]);
  });

  it('hides runcell-internal tools from the stream', () => {
    const converter = createUIMessageChunkConverter();
    const chunks = [
      ...converter.handlePart({
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'submitResult',
        input: { ok: true },
      }),
      ...converter.handlePart({
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'fileChange',
        output: {},
      }),
    ];
    expect(chunks).toEqual([]);
  });

  it('maps repair turns onto separate steps', () => {
    const converter = createUIMessageChunkConverter();
    const chunks = [
      ...converter.handlePart({ type: 'text-delta', id: 't1', text: 'a' }),
      ...converter.handlePart({ type: 'finish', finishReason: 'stop' }),
      ...converter.handlePart({ type: 'text-delta', id: 't2', text: 'b' }),
      ...converter.handlePart({ type: 'finish', finishReason: 'stop' }),
      ...converter.finish(runResult()),
    ];

    expect(chunks.map(chunk => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
  });

  it('closes interrupted blocks and reports usage metadata on failure', () => {
    const converter = createUIMessageChunkConverter({
      onError: error => (error instanceof Error ? error.message : 'unknown'),
    });
    void converter.handlePart({ type: 'text-start', id: 't1' });
    void converter.handlePart({ type: 'text-delta', id: 't1', text: 'par' });

    const error = new TurnError('provider exploded', { usage });
    const chunks = converter.fail(error);

    expect(chunks).toEqual([
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'message-metadata', messageMetadata: { usage } },
      { type: 'error', errorText: 'provider exploded' },
    ]);
  });

  it('opens the message on a failure before any parts and masks the error', () => {
    const converter = createUIMessageChunkConverter();
    const chunks = converter.fail(new Error('secret internals'));
    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'error', errorText: 'An error occurred.' },
    ]);
  });

  it('drops reasoning when sendReasoning is false', () => {
    const converter = createUIMessageChunkConverter({ sendReasoning: false });
    const chunks = [
      ...converter.handlePart({ type: 'reasoning-start', id: 'r1' }),
      ...converter.handlePart({ type: 'reasoning-delta', id: 'r1', text: 's' }),
      ...converter.handlePart({ type: 'reasoning-end', id: 'r1' }),
      ...converter.handlePart({ type: 'text-delta', id: 't1', text: 'ok' }),
    ];
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
    ]);
  });

  it('redacts tool payloads with sendTools names-only', () => {
    const converter = createUIMessageChunkConverter({
      sendTools: 'names-only',
    });
    const chunks = [
      ...converter.handlePart({
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'weather',
        input: { city: 'lima' },
      }),
      ...converter.handlePart({
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'weather',
        output: { tempC: 18 },
      }),
    ];
    expect(chunks).toEqual([
      { type: 'start' },
      { type: 'start-step' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'weather',
        input: null,
      },
      { type: 'tool-output-available', toolCallId: 'c1', output: null },
    ]);
  });

  it('hides tool activity entirely with sendTools false', () => {
    const converter = createUIMessageChunkConverter({ sendTools: false });
    const chunks = [
      ...converter.handlePart({
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'weather',
        input: {},
      }),
      ...converter.handlePart({
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'weather',
        output: {},
      }),
    ];
    expect(chunks).toEqual([]);
  });

  it('ignores parts that have no UI mapping', () => {
    const converter = createUIMessageChunkConverter();
    expect(converter.handlePart({ type: 'stream-start' })).toEqual([]);
    expect(
      converter.handlePart({ type: 'error', error: new Error('x') }),
    ).toEqual([]);
  });
});

describe('uiChatMessageText', () => {
  it('joins text parts and ignores other part types', () => {
    expect(
      uiChatMessageText({
        role: 'user',
        parts: [
          { type: 'text', text: 'a' },
          { type: 'tool-weather' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab');
  });

  it('falls back to a plain content string', () => {
    expect(uiChatMessageText({ role: 'user', content: 'plain' })).toBe('plain');
  });

  it('returns empty for messages without text', () => {
    expect(uiChatMessageText({ role: 'user' })).toBe('');
  });
});

describe('uiChatMessagesToPrompt', () => {
  it('uses a lone user message as the prompt', () => {
    expect(
      uiChatMessagesToPrompt([
        { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ]),
    ).toBe('hello');
  });

  it('replays prior turns as conversation context', () => {
    expect(
      uiChatMessagesToPrompt([
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'hey there' }] },
        { role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
      ]),
    ).toBe('Conversation so far:\nUser: hi\nAssistant: hey there\n\nfollow up');
  });

  it('skips prior messages with no text', () => {
    expect(
      uiChatMessagesToPrompt([
        { role: 'assistant', parts: [{ type: 'tool-weather' }] },
        { role: 'user', parts: [{ type: 'text', text: 'q' }] },
      ]),
    ).toBe('q');
  });
});

describe('uiMessageChunksToResponse', () => {
  it('serializes chunks as the UI message stream SSE format', async () => {
    const response = uiMessageChunksToResponse(
      toAsyncIterable([
        { type: 'start' },
        { type: 'text-delta', id: 't1', delta: 'hi' },
      ]),
    );

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(response.headers.get('cache-control')).toBe('no-cache');

    const body = await response.text();
    expect(body).toBe(
      'data: {"type":"start"}\n\n' +
        'data: {"type":"text-delta","id":"t1","delta":"hi"}\n\n' +
        'data: [DONE]\n\n',
    );
  });

  it('honors caller-provided status and extra headers', async () => {
    const response = uiMessageChunksToResponse(toAsyncIterable([]), {
      status: 201,
      headers: { 'x-custom': 'yes' },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-custom')).toBe('yes');
    expect(await response.text()).toBe('data: [DONE]\n\n');
  });
});
