import { describe, expect, it } from 'vitest';
import { InvalidOptionError, TurnError } from './errors.js';
import type { RunResult, RunUsage } from './types.js';
import {
  createUIMessageChunkConverter,
  uiChatMessagesToRunInput,
  uiChatMessageText,
  uiMessageChunksToResponse,
} from './ui-message-stream.js';
import type { UIChatMessage, UIMessageChunk } from './types.js';
import { uiChatMessageAttachments } from './index.js';

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

describe('uiChatMessagesToRunInput', () => {
  it('uses a lone user message as the prompt', () => {
    expect(
      uiChatMessagesToRunInput([
        { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ]),
    ).toEqual({ prompt: 'hello', files: [] });
  });

  it('replays prior turns as conversation context', () => {
    expect(
      uiChatMessagesToRunInput([
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'hey there' }] },
        { role: 'user', parts: [{ type: 'text', text: 'follow up' }] },
      ]).prompt,
    ).toBe('Conversation so far:\nUser: hi\nAssistant: hey there\n\nfollow up');
  });

  it('skips prior messages with no text', () => {
    expect(
      uiChatMessagesToRunInput([
        { role: 'assistant', parts: [{ type: 'tool-weather' }] },
        { role: 'user', parts: [{ type: 'text', text: 'q' }] },
      ]).prompt,
    ).toBe('q');
  });

  it('seeds last-message file parts as workspace attachments', () => {
    const png = Buffer.from('fake-png-bytes').toString('base64');
    const { prompt, files } = uiChatMessagesToRunInput([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'describe this image' },
          {
            type: 'file',
            url: `data:image/png;base64,${png}`,
            mediaType: 'image/png',
            filename: 'photo.png',
          },
        ],
      },
    ]);

    expect(files).toEqual([
      {
        path: 'attachments/photo.png',
        bytes: Uint8Array.from(Buffer.from('fake-png-bytes')),
        mediaType: 'image/png',
      },
    ]);
    expect(prompt).toBe(
      'describe this image\n\n' +
        'The user attached this file to the message:\n- attachments/photo.png',
    );
  });

  it('names unnamed attachments from their media type and dedupes collisions', () => {
    const data = Buffer.from('x').toString('base64');
    const { files } = uiChatMessagesToRunInput([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'read these' },
          { type: 'file', url: `data:application/pdf;base64,${data}` },
          {
            type: 'file',
            url: `data:text/plain;base64,${data}`,
            filename: 'notes.txt',
          },
          {
            type: 'file',
            url: `data:text/plain;base64,${data}`,
            filename: 'notes.txt',
          },
        ],
      },
    ]);
    expect(files.map(file => file.path)).toEqual([
      'attachments/attachment-1.pdf',
      'attachments/notes.txt',
      'attachments/notes-2.txt',
    ]);
  });

  it('decodes non-base64 data URLs', () => {
    const { files } = uiChatMessagesToRunInput([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'go' },
          { type: 'file', url: 'data:text/plain,hello%20world' },
        ],
      },
    ]);
    expect(new TextDecoder().decode(files[0]?.bytes)).toBe('hello world');
    expect(files[0]?.mediaType).toBe('text/plain');
  });

  it('enforces the default attachment size limit', () => {
    const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    expect(() =>
      uiChatMessagesToRunInput([
        {
          role: 'user',
          parts: [{ type: 'file', url: `data:application/pdf;base64,${big}` }],
        },
      ]),
    ).toThrow('maxAttachmentBytes');
  });

  it('honors a raised maxAttachmentBytes', () => {
    const big = Buffer.alloc(21 * 1024 * 1024).toString('base64');
    const { files } = uiChatMessagesToRunInput(
      [
        {
          role: 'user',
          parts: [{ type: 'file', url: `data:application/pdf;base64,${big}` }],
        },
      ],
      { maxAttachmentBytes: 32 * 1024 * 1024 },
    );
    expect(files[0]?.bytes.byteLength).toBe(21 * 1024 * 1024);
  });

  it('rejects remote file URLs', () => {
    expect(() =>
      uiChatMessagesToRunInput([
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'go' },
            { type: 'file', url: 'https://example.com/a.png' },
          ],
        },
      ]),
    ).toThrow('data URL');
  });

  it('sanitizes hostile attachment filenames', () => {
    const data = Buffer.from('x').toString('base64');
    const { files } = uiChatMessagesToRunInput([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'go' },
          {
            type: 'file',
            url: `data:text/plain;base64,${data}`,
            filename: '../../etc/passwd',
          },
        ],
      },
    ]);
    expect(files[0]?.path).toBe('attachments/passwd');
  });

  it('re-seeds earlier-message attachments so documents survive the conversation', () => {
    const data = Buffer.from('x').toString('base64');
    const { prompt, files } = uiChatMessagesToRunInput([
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'here is a chart' },
          {
            type: 'file',
            url: `data:image/png;base64,${data}`,
            filename: 'chart.png',
          },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'nice chart' }] },
      { role: 'user', parts: [{ type: 'text', text: 'summarize it' }] },
    ]);
    // The earlier attachment is seeded again: clients resend the full
    // history, so the bytes are present on every request.
    expect(files.map(file => file.path)).toEqual(['attachments/chart.png']);
    expect(prompt).toBe(
      'Conversation so far:\n' +
        'User: here is a chart [attached: attachments/chart.png]\n' +
        'Assistant: nice chart\n\n' +
        'summarize it',
    );
  });

  it('keeps attachment paths stable across turns', () => {
    const data = Buffer.from('x').toString('base64');
    const firstTurn: Parameters<typeof uiChatMessagesToRunInput>[0] = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'read this' },
          { type: 'file', url: `data:application/pdf;base64,${data}` },
        ],
      },
    ];
    const secondTurn = [
      ...firstTurn,
      { role: 'assistant' as const, parts: [{ type: 'text', text: 'done' }] },
      { role: 'user' as const, parts: [{ type: 'text', text: 'page 2?' }] },
    ];

    const first = uiChatMessagesToRunInput(firstTurn);
    const second = uiChatMessagesToRunInput(secondTurn);
    expect(first.files.map(file => file.path)).toEqual(
      second.files.map(file => file.path),
    );
    expect(second.prompt).toContain('[attached: attachments/attachment-1.pdf]');
  });
});

describe('uiChatMessageAttachments', () => {
  const dataUrl = (mediaType: string, text: string): string =>
    `data:${mediaType};base64,${Buffer.from(text).toString('base64')}`;

  it('dedupes the same filename across turns in message order', () => {
    const messages: UIChatMessage[] = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'first photo' },
          {
            type: 'file',
            url: dataUrl('image/jpeg', 'photo-1'),
            mediaType: 'image/jpeg',
            filename: 'image.jpg',
          },
        ],
      },
      { role: 'assistant', parts: [{ type: 'text', text: 'got it' }] },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'second photo' },
          {
            type: 'file',
            url: dataUrl('image/jpeg', 'photo-2'),
            mediaType: 'image/jpeg',
            filename: 'image.jpg',
          },
        ],
      },
    ];

    expect(uiChatMessageAttachments(messages)).toEqual([
      {
        path: 'attachments/image.jpg',
        filename: 'image.jpg',
        mediaType: 'image/jpeg',
        bytes: Uint8Array.from(Buffer.from('photo-1')),
      },
      {
        path: 'attachments/image-2.jpg',
        filename: 'image.jpg',
        mediaType: 'image/jpeg',
        bytes: Uint8Array.from(Buffer.from('photo-2')),
      },
    ]);
  });

  it('keeps the original filename when sanitizing makes names collide', () => {
    const attachments = uiChatMessageAttachments([
      {
        role: 'user',
        parts: [
          {
            type: 'file',
            url: dataUrl('image/png', 'a'),
            filename: 'foto factura.png',
          },
          {
            type: 'file',
            url: dataUrl('image/png', 'b'),
            filename: 'foto_factura.png',
          },
        ],
      },
    ]);
    expect(
      attachments.map(({ path, filename }) => ({ path, filename })),
    ).toEqual([
      { path: 'attachments/foto_factura.png', filename: 'foto factura.png' },
      { path: 'attachments/foto_factura-2.png', filename: 'foto_factura.png' },
    ]);
  });

  it('names an unnamed file part from its media type and omits filename', () => {
    const attachments = uiChatMessageAttachments([
      {
        role: 'user',
        parts: [
          {
            type: 'file',
            url: dataUrl('text/plain', 'x'),
            filename: 'notes.txt',
          },
          {
            type: 'file',
            url: dataUrl('image/png', 'y'),
            mediaType: 'image/png',
          },
        ],
      },
    ]);
    expect(attachments[1]?.path).toBe('attachments/attachment-2.png');
    expect(attachments[1]).not.toHaveProperty('filename');
  });

  it('returns the paths the run prompt names, in the same order', () => {
    const messages: UIChatMessage[] = [
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'one' },
          {
            type: 'file',
            url: dataUrl('image/jpeg', '1'),
            filename: 'image.jpg',
          },
          { type: 'file', url: dataUrl('application/pdf', '2') },
        ],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'ok' },
          // Assistant file parts are not seeded.
          { type: 'file', url: dataUrl('image/png', '3'), filename: 'x.png' },
        ],
      },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'two' },
          {
            type: 'file',
            url: dataUrl('image/jpeg', '4'),
            filename: 'image.jpg',
          },
        ],
      },
    ];

    const attachments = uiChatMessageAttachments(messages);
    const runInput = uiChatMessagesToRunInput(messages);
    expect(attachments.map(attachment => attachment.path)).toEqual([
      'attachments/image.jpg',
      'attachments/attachment-2.pdf',
      'attachments/image-2.jpg',
    ]);
    expect(runInput.files).toEqual(
      attachments.map(({ path, bytes, mediaType }) => ({
        path,
        bytes,
        ...(mediaType !== undefined ? { mediaType } : {}),
      })),
    );
    expect(runInput.prompt).toContain(
      '[attached: attachments/image.jpg, attachments/attachment-2.pdf]',
    );
    expect(runInput.prompt).toContain('- attachments/image-2.jpg');
  });

  it('rejects oversized attachments with the run error', () => {
    const messages: UIChatMessage[] = [
      {
        role: 'user',
        parts: [{ type: 'file', url: dataUrl('text/plain', 'too long') }],
      },
    ];
    const options = { maxAttachmentBytes: 4 };
    const runError = (() => {
      try {
        uiChatMessagesToRunInput(messages, options);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(runError).toBeInstanceOf(InvalidOptionError);
    expect(() => uiChatMessageAttachments(messages, options)).toThrow(runError);
    expect(() => uiChatMessageAttachments(messages, options)).toThrow(
      InvalidOptionError,
    );
    expect(() => uiChatMessageAttachments(messages, options)).toThrow(
      'maxAttachmentBytes',
    );
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
