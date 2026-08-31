import { getRunUsage } from './errors.js';
import type { RunResult, UIChatMessage, UIMessageChunk } from './types.js';

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

/**
 * Fold a UI chat history into a single prompt: the last user message is the
 * task, and earlier turns are replayed as conversation context in the same
 * format threads use for neutral replay.
 */
export function uiChatMessagesToPrompt(
  messages: readonly UIChatMessage[],
): string {
  const last = messages.at(-1);
  if (last === undefined) {
    return '';
  }
  const prior = messages
    .slice(0, -1)
    .map(message => ({ role: message.role, text: uiChatMessageText(message) }))
    .filter(message => message.text.trim().length > 0);
  const lastText = uiChatMessageText(last);
  if (prior.length === 0) {
    return lastText;
  }
  const speaker = { system: 'System', user: 'User', assistant: 'Assistant' };
  const lines = prior.map(
    message => `${speaker[message.role]}: ${message.text}`,
  );
  return `Conversation so far:\n${lines.join('\n')}\n\n${lastText}`;
}

/** Tools that are runcell plumbing, not conversation content. */
const INTERNAL_TOOL_NAMES = new Set(['submitResult', 'fileChange']);

/**
 * Stateful converter from the runtime's normalized stream parts to UI
 * Message Stream chunks. One instance per run: it opens the message on the
 * first part, maps repair turns onto step boundaries, and closes any block
 * left open by an interrupted turn before terminal chunks.
 */
export function createUIMessageChunkConverter(): {
  handlePart(part: { type: string; [key: string]: unknown }): UIMessageChunk[];
  finish(result: RunResult<unknown>): UIMessageChunk[];
  fail(error: unknown): UIMessageChunk[];
} {
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
          openMessageAndStep(chunks);
          openReasoningId = readId(part);
          chunks.push({ type: 'reasoning-start', id: openReasoningId });
          return chunks;
        }
        case 'reasoning-delta': {
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
          openMessageAndStep(chunks);
          closeOpenBlocks(chunks);
          chunks.push({
            type: 'tool-input-available',
            toolCallId: readToolCallId(part),
            toolName,
            input: part['input'],
          });
          return chunks;
        }
        case 'tool-result': {
          const toolName = readToolName(part);
          if (!toolName || INTERNAL_TOOL_NAMES.has(toolName)) {
            return chunks;
          }
          openMessageAndStep(chunks);
          chunks.push({
            type: 'tool-output-available',
            toolCallId: readToolCallId(part),
            output: part['output'],
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
      closeOpenBlocks(chunks);
      if (stepOpen) {
        chunks.push({ type: 'finish-step' });
        stepOpen = false;
      }
      const usage = getRunUsage(error);
      if (usage) {
        chunks.push({ type: 'message-metadata', messageMetadata: { usage } });
      }
      chunks.push({ type: 'error', errorText: errorText(error) });
      return chunks;
    },
  };
}

function errorText(error: unknown): string {
  try {
    if (error instanceof Error && typeof error.message === 'string') {
      return error.message;
    }
    return String(error);
  } catch {
    return 'Agent run failed.';
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
