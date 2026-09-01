import { getRunUsage } from './errors.js';
import type {
  RunResult,
  UIChatMessage,
  UIMessageChunk,
  UIMessageStreamOptions,
} from './types.js';

/**
 * Extract the text of one UI chat message: `parts` entries of type `text`,
 * with a plain `content` string accepted as a fallback.
 */
export function uiChatMessageText(message: UIChatMessage): string {
  const texts: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  if (texts.length > 0) {
    return texts.join('');
  }
  return typeof message.content === 'string' ? message.content : '';
}

/** File parts of one UI chat message (AI SDK attachment shape). */
export function uiChatMessageFileParts(
  message: UIChatMessage,
): { url: string; mediaType?: string; filename?: string }[] {
  const files: { url: string; mediaType?: string; filename?: string }[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'file' && typeof part.url === 'string') {
      files.push({
        url: part.url,
        ...(typeof part.mediaType === 'string'
          ? { mediaType: part.mediaType }
          : {}),
        ...(typeof part.filename === 'string'
          ? { filename: part.filename }
          : {}),
      });
    }
  }
  return files;
}

/** Default per-attachment size limit; override with `maxAttachmentBytes`. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'text/csv': 'csv',
};

function attachmentPath(
  file: { mediaType?: string; filename?: string },
  index: number,
  used: Set<string>,
): string {
  // Keep only a safe basename; the caller-supplied name is untrusted input.
  const base = ((file.filename ?? '').split(/[/\\]/).at(-1) ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  const extension =
    file.mediaType !== undefined
      ? MEDIA_TYPE_EXTENSIONS[file.mediaType.toLowerCase()]
      : undefined;
  const name =
    base.length > 0
      ? base
      : `attachment-${index + 1}${extension ? `.${extension}` : ''}`;
  let candidate = `attachments/${name}`;
  let suffix = 2;
  while (used.has(candidate)) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    candidate = `attachments/${stem}-${suffix}${ext}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function decodeDataUrl(
  url: string,
  maxBytes: number,
): {
  bytes: Uint8Array;
  mediaType?: string;
} {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(url);
  if (!match) {
    throw new Error(
      'file parts in "messages" must use a data URL. Fetch remote URLs in ' +
        'your application and inline the bytes.',
    );
  }
  const [, mediaType, base64, data] = match;
  const bytes = base64
    ? Uint8Array.from(Buffer.from(data ?? '', 'base64'))
    : new TextEncoder().encode(decodeURIComponent(data ?? ''));
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `file parts in "messages" are limited to ${maxBytes} bytes each. ` +
        'Raise the limit with the "maxAttachmentBytes" run option.',
    );
  }
  return {
    bytes,
    ...(mediaType ? { mediaType } : {}),
  };
}

export interface UIChatRunInput {
  prompt: string;
  /** Attachments from the last user message, seeded into the workspace. */
  files: { path: string; bytes: Uint8Array; mediaType?: string }[];
}

/**
 * Fold a UI chat history into a prompt plus workspace files. The last user
 * message is the task; its `file` parts (data URLs) become files under
 * `attachments/`, listed at the end of the prompt so the agent reads them
 * with its file tools. Earlier turns are replayed as conversation context in
 * the same format threads use for neutral replay, with file parts shown as
 * placeholders.
 */
export function uiChatMessagesToRunInput(
  messages: readonly UIChatMessage[],
  options?: { maxAttachmentBytes?: number },
): UIChatRunInput {
  const maxAttachmentBytes =
    options?.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const last = messages.at(-1);
  if (last === undefined) {
    return { prompt: '', files: [] };
  }

  const describe = (message: UIChatMessage): string => {
    const text = uiChatMessageText(message);
    const names = uiChatMessageFileParts(message).map(
      (file, index) => file.filename ?? `attachment-${index + 1}`,
    );
    const attachments =
      names.length > 0 ? `[attached: ${names.join(', ')}]` : '';
    return [text, attachments].filter(Boolean).join(' ');
  };

  const usedPaths = new Set<string>();
  const files = uiChatMessageFileParts(last).map((file, index) => {
    const decoded = decodeDataUrl(file.url, maxAttachmentBytes);
    const mediaType = file.mediaType ?? decoded.mediaType;
    return {
      path: attachmentPath(
        {
          ...(mediaType !== undefined ? { mediaType } : {}),
          ...(file.filename !== undefined ? { filename: file.filename } : {}),
        },
        index,
        usedPaths,
      ),
      bytes: decoded.bytes,
      ...(mediaType !== undefined ? { mediaType } : {}),
    };
  });

  const attachmentNote =
    files.length > 0
      ? `The user attached ${files.length === 1 ? 'this file' : 'these files'} to the message:\n${files
          .map(file => `- ${file.path}`)
          .join('\n')}`
      : undefined;

  const prior = messages
    .slice(0, -1)
    .map(message => ({ role: message.role, text: describe(message) }))
    .filter(message => message.text.trim().length > 0);
  const lastText = uiChatMessageText(last);

  const speaker = { system: 'System', user: 'User', assistant: 'Assistant' };
  const transcript =
    prior.length > 0
      ? `Conversation so far:\n${prior
          .map(message => `${speaker[message.role]}: ${message.text}`)
          .join('\n')}`
      : undefined;

  const prompt = [transcript, lastText, attachmentNote]
    .filter((section): section is string => Boolean(section?.trim()))
    .join('\n\n');
  return { prompt, files };
}

/** Tools that are runcell plumbing, not conversation content. */
const INTERNAL_TOOL_NAMES = new Set(['submitResult', 'fileChange']);

/**
 * Stateful converter from the runtime's normalized stream parts to UI
 * Message Stream chunks. One instance per run: it opens the message on the
 * first part, maps repair turns onto step boundaries, and closes any block
 * left open by an interrupted turn before terminal chunks.
 */
type ToolPolicy = 'full' | 'names-only' | 'hidden';

function resolveToolPolicy(
  sendTools: UIMessageStreamOptions['sendTools'],
  toolName: string,
): ToolPolicy {
  const asPolicy = (value: boolean | 'names-only' | undefined): ToolPolicy =>
    value === false ? 'hidden' : value === 'names-only' ? 'names-only' : 'full';
  if (sendTools === undefined || typeof sendTools === 'boolean') {
    return asPolicy(sendTools);
  }
  if (sendTools === 'names-only') {
    return 'names-only';
  }
  return asPolicy(sendTools[toolName]);
}

export function createUIMessageChunkConverter(
  options: UIMessageStreamOptions = {},
): {
  handlePart(part: { type: string; [key: string]: unknown }): UIMessageChunk[];
  finish(result: RunResult<unknown>): UIMessageChunk[];
  fail(error: unknown): UIMessageChunk[];
} {
  const sendReasoning = options.sendReasoning ?? true;
  // Mirrors the AI SDK default: never leak server error details unless the
  // caller explicitly opts in.
  const onError = options.onError ?? (() => 'An error occurred.');

  let messageStarted = false;
  let stepOpen = false;
  let openTextId: string | undefined;
  let openReasoningId: string | undefined;

  const openMessageAndStep = (chunks: UIMessageChunk[]): void => {
    if (!messageStarted) {
      messageStarted = true;
      chunks.push({ type: 'start' });
    }
    if (!stepOpen) {
      stepOpen = true;
      chunks.push({ type: 'start-step' });
    }
  };

  const closeOpenBlocks = (chunks: UIMessageChunk[]): void => {
    if (openTextId !== undefined) {
      chunks.push({ type: 'text-end', id: openTextId });
      openTextId = undefined;
    }
    if (openReasoningId !== undefined) {
      chunks.push({ type: 'reasoning-end', id: openReasoningId });
      openReasoningId = undefined;
    }
  };

  const readId = (part: Record<string, unknown>): string =>
    typeof part['id'] === 'string' ? part['id'] : 'block';

  const readDelta = (part: Record<string, unknown>): string => {
    const delta = part['text'] ?? part['delta'];
    return typeof delta === 'string' ? delta : '';
  };

  const readToolName = (part: Record<string, unknown>): string =>
    typeof part['toolName'] === 'string' ? part['toolName'] : '';

  const readToolCallId = (part: Record<string, unknown>): string =>
    typeof part['toolCallId'] === 'string' ? part['toolCallId'] : '';

  return {
    handlePart(part) {
      const chunks: UIMessageChunk[] = [];
      switch (part.type) {
        case 'text-start': {
          openMessageAndStep(chunks);
          openTextId = readId(part);
          chunks.push({ type: 'text-start', id: openTextId });
          return chunks;
        }
        case 'text-delta': {
          openMessageAndStep(chunks);
          // The adapter opens blocks explicitly, but tolerate a bare delta.
          if (openTextId === undefined) {
            openTextId = readId(part);
            chunks.push({ type: 'text-start', id: openTextId });
          }
          chunks.push({
            type: 'text-delta',
            id: openTextId,
            delta: readDelta(part),
          });
          return chunks;
        }
        case 'text-end': {
          if (openTextId !== undefined) {
            chunks.push({ type: 'text-end', id: openTextId });
            openTextId = undefined;
          }
          return chunks;
        }
        case 'reasoning-start': {
          if (!sendReasoning) {
            return chunks;
          }
          openMessageAndStep(chunks);
          openReasoningId = readId(part);
          chunks.push({ type: 'reasoning-start', id: openReasoningId });
          return chunks;
        }
        case 'reasoning-delta': {
          if (!sendReasoning) {
            return chunks;
          }
          openMessageAndStep(chunks);
          if (openReasoningId === undefined) {
            openReasoningId = readId(part);
            chunks.push({ type: 'reasoning-start', id: openReasoningId });
          }
          chunks.push({
            type: 'reasoning-delta',
            id: openReasoningId,
            delta: readDelta(part),
          });
          return chunks;
        }
        case 'reasoning-end': {
          if (openReasoningId !== undefined) {
            chunks.push({ type: 'reasoning-end', id: openReasoningId });
            openReasoningId = undefined;
          }
          return chunks;
        }
        case 'tool-call': {
          const toolName = readToolName(part);
          if (!toolName || INTERNAL_TOOL_NAMES.has(toolName)) {
            return chunks;
          }
          const policy = resolveToolPolicy(options.sendTools, toolName);
          if (policy === 'hidden') {
            return chunks;
          }
          openMessageAndStep(chunks);
          closeOpenBlocks(chunks);
          chunks.push({
            type: 'tool-input-available',
            toolCallId: readToolCallId(part),
            toolName,
            input: policy === 'names-only' ? null : part['input'],
          });
          return chunks;
        }
        case 'tool-result': {
          const toolName = readToolName(part);
          if (!toolName || INTERNAL_TOOL_NAMES.has(toolName)) {
            return chunks;
          }
          const policy = resolveToolPolicy(options.sendTools, toolName);
          if (policy === 'hidden') {
            return chunks;
          }
          openMessageAndStep(chunks);
          chunks.push({
            type: 'tool-output-available',
            toolCallId: readToolCallId(part),
            output: policy === 'names-only' ? null : part['output'],
          });
          return chunks;
        }
        case 'finish': {
          // A turn ended. A repair turn may follow; the next part reopens a
          // step. The run-level `finish` chunk is emitted from finish().
          if (stepOpen) {
            closeOpenBlocks(chunks);
            chunks.push({ type: 'finish-step' });
            stepOpen = false;
          }
          return chunks;
        }
        default:
          // stream-start, error (handled via the run's rejection), and
          // adapter-internal parts do not map to UI chunks.
          return chunks;
      }
    },

    finish(result) {
      const chunks: UIMessageChunk[] = [];
      // A run that produced no parts still emits a well-formed message; a
      // step already closed by the last turn's `finish` part stays closed.
      if (!messageStarted) {
        messageStarted = true;
        chunks.push({ type: 'start' });
      }
      closeOpenBlocks(chunks);
      if (stepOpen) {
        chunks.push({ type: 'finish-step' });
        stepOpen = false;
      }
      chunks.push({
        type: 'finish',
        messageMetadata: { usage: result.usage, sessionId: result.sessionId },
      });
      return chunks;
    },

    fail(error) {
      const chunks: UIMessageChunk[] = [];
      // A failure before any parts still opens the message, so consumers
      // always receive a well-formed `start` before the in-band error.
      if (!messageStarted) {
        messageStarted = true;
        chunks.push({ type: 'start' });
      }
      closeOpenBlocks(chunks);
      if (stepOpen) {
        chunks.push({ type: 'finish-step' });
        stepOpen = false;
      }
      const usage = getRunUsage(error);
      if (usage) {
        chunks.push({ type: 'message-metadata', messageMetadata: { usage } });
      }
      let errorText: string;
      try {
        errorText = onError(error);
      } catch {
        errorText = 'An error occurred.';
      }
      chunks.push({ type: 'error', errorText });
      return chunks;
    },
  };
}

/**
 * Convert a run's raw part stream plus its result promise into UI message
 * chunks. Single-consumer; both `toUIMessageStream` and
 * `toUIMessageStreamResponse` are built on this.
 */
export async function* uiMessageStreamFromRun(
  parts: AsyncIterable<{ type: string; [key: string]: unknown }>,
  result: Promise<RunResult<unknown>>,
  options?: UIMessageStreamOptions,
): AsyncIterable<UIMessageChunk> {
  const converter = createUIMessageChunkConverter(options);
  for await (const part of parts) {
    yield* converter.handlePart(part);
  }
  try {
    yield* converter.finish(await result);
  } catch (error) {
    yield* converter.fail(error);
  }
}

/**
 * Headers of the UI Message Stream SSE protocol, as sent by AI SDK's
 * `toUIMessageStreamResponse`.
 */
const UI_MESSAGE_STREAM_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
  'x-accel-buffering': 'no',
} as const;

/**
 * Serialize UI message chunks as the SSE wire format `useChat` and
 * assistant-ui consume: one `data: <json>` event per chunk, closed with
 * `data: [DONE]`.
 */
export function uiMessageChunksToResponse(
  chunks: AsyncIterable<UIMessageChunk>,
  init?: ResponseInit,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
          );
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return new Response(body, {
    status: init?.status ?? 200,
    ...(init?.statusText !== undefined ? { statusText: init.statusText } : {}),
    headers,
  });
}
