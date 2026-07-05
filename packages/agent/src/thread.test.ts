import { describe, expect, it } from 'vitest';
import {
  appendThreadMessage,
  createThread,
  getThreadInternals,
  renderThreadContext,
  threadFromJSON,
} from './thread.js';

describe('createThread', () => {
  it('starts empty with a stable id', () => {
    const thread = createThread({ id: 'chat-1' });
    expect(thread.id).toBe('chat-1');
    expect(thread.messages).toEqual([]);
    expect(getThreadInternals(thread)).toBeDefined();
  });

  it('generates an id when none is given', () => {
    const thread = createThread();
    expect(thread.id.length).toBeGreaterThan(0);
  });
});

describe('serialization', () => {
  it('round-trips through toJSON and threadFromJSON', () => {
    const thread = createThread({ id: 'chat-2' });
    const internals = getThreadInternals(thread);
    if (!internals) throw new Error('expected internals');
    appendThreadMessage(internals, { role: 'user', content: 'hello' });
    appendThreadMessage(internals, {
      role: 'agent',
      content: 'hi',
      data: { ok: true },
    });

    const json = thread.toJSON();
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);

    const restored = threadFromJSON(json);
    expect(restored.id).toBe('chat-2');
    expect(restored.messages).toEqual(thread.messages);
    expect(getThreadInternals(restored)).toBeDefined();
  });

  it('preserves an opaque continuation', () => {
    const continuation = {
      engine: 'pi',
      resume: { sessionFileName: 'x.jsonl' },
      journalGz: 'AAAA',
    };
    const restored = threadFromJSON({
      version: 1,
      id: 'chat-3',
      messages: [],
      continuation,
    });
    expect(restored.toJSON().continuation).toEqual(continuation);
  });
});

describe('clone', () => {
  it('produces an independent deep copy', () => {
    const thread = createThread({ id: 'chat-4' });
    const internals = getThreadInternals(thread);
    if (!internals) throw new Error('expected internals');
    appendThreadMessage(internals, { role: 'user', content: 'first' });

    const branch = thread.clone();
    const branchInternals = getThreadInternals(branch);
    if (!branchInternals) throw new Error('expected branch internals');
    appendThreadMessage(branchInternals, {
      role: 'user',
      content: 'only-branch',
    });

    expect(thread.messages).toHaveLength(1);
    expect(branch.messages).toHaveLength(2);
    expect(branch.id).toBe('chat-4');
  });
});

describe('getThreadInternals', () => {
  it('returns undefined for foreign objects', () => {
    expect(getThreadInternals(undefined)).toBeUndefined();
    expect(getThreadInternals({ id: 'x', messages: [] })).toBeUndefined();
  });
});

describe('renderThreadContext', () => {
  it('returns undefined with no messages', () => {
    expect(renderThreadContext([])).toBeUndefined();
  });

  it('renders user and agent turns with structured results', () => {
    const context = renderThreadContext([
      { role: 'user', content: 'ping', createdAt: 't1' },
      { role: 'agent', content: 'pong', data: { n: 1 }, createdAt: 't2' },
    ]);
    expect(context).toBe(
      'Conversation so far:\nUser: ping\nAssistant: pong\nResult: {"n":1}',
    );
  });
});
