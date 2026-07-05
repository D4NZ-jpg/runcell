import { randomUUID } from 'node:crypto';

/**
 * One turn in a conversation. Neutral and portable: no engine-specific fields,
 * so a thread can be serialized, stored anywhere, forked, and replayed.
 */
export interface ThreadMessage {
  /** `user` for a prompt, `agent` for a model response. */
  role: 'user' | 'agent';
  /** The prompt text, or the agent's free-form response text. */
  content: string;
  /** The validated structured result, on `agent` turns. */
  data?: unknown;
  /** ISO timestamp for when the turn was recorded. */
  createdAt: string;
}

/**
 * Opaque, engine-specific continuation token. Reserved for lossless resume; the
 * neutral message log is always the source of truth, and this is only ever used
 * as an optimization when it is present and still valid.
 */
export type ThreadProviderState = Record<string, unknown>;

/**
 * The serializable form of a {@link Thread}. Persist this wherever you like and
 * rebuild with {@link threadFromJSON}.
 */
export interface ThreadState {
  version: 1;
  id: string;
  messages: ThreadMessage[];
  providerState?: ThreadProviderState;
}

/**
 * A mutable conversation handle. Pass it to {@link Agent.run} to give the agent
 * prior context; runcell appends the new turns in place. Fork with
 * {@link Thread.clone} and persist with {@link Thread.toJSON}.
 */
export interface Thread {
  readonly id: string;
  /** The turns recorded so far, oldest first. */
  readonly messages: readonly ThreadMessage[];
  /** Deep copy this thread into an independent handle. */
  clone(): Thread;
  /** Serialize to a plain, portable value. */
  toJSON(): ThreadState;
}

interface ThreadInternalState {
  messages: ThreadMessage[];
  providerState: ThreadProviderState | undefined;
}

const internalsRegistry = new WeakMap<Thread, ThreadInternalState>();

class ThreadHandle implements Thread {
  readonly id: string;
  private readonly state: ThreadInternalState;

  constructor(id: string, state: ThreadInternalState) {
    this.id = id;
    this.state = state;
  }

  get messages(): readonly ThreadMessage[] {
    return this.state.messages;
  }

  clone(): Thread {
    return threadFromJSON(this.toJSON());
  }

  toJSON(): ThreadState {
    return {
      version: 1,
      id: this.id,
      messages: this.state.messages.map(message => ({ ...message })),
      ...(this.state.providerState !== undefined
        ? { providerState: { ...this.state.providerState } }
        : {}),
    };
  }
}

/** Create a new, empty conversation thread. */
export function createThread(options: { id?: string } = {}): Thread {
  const state: ThreadInternalState = { messages: [], providerState: undefined };
  const thread = new ThreadHandle(options.id ?? randomUUID(), state);
  internalsRegistry.set(thread, state);
  return thread;
}

/** Rebuild a thread from a previously serialized {@link ThreadState}. */
export function threadFromJSON(state: ThreadState): Thread {
  const internal: ThreadInternalState = {
    messages: state.messages.map(message => ({ ...message })),
    providerState:
      state.providerState !== undefined
        ? { ...state.providerState }
        : undefined,
  };
  const thread = new ThreadHandle(state.id, internal);
  internalsRegistry.set(thread, internal);
  return thread;
}

/**
 * Retrieve the mutable internals for a runcell thread, or `undefined` for
 * foreign objects. Internal.
 */
export function getThreadInternals(
  thread: unknown,
): ThreadInternalState | undefined {
  return typeof thread === 'object' && thread !== null
    ? internalsRegistry.get(thread as Thread)
    : undefined;
}

/** Append a turn to a thread's internal state. Internal. */
export function appendThreadMessage(
  internals: ThreadInternalState,
  message: Omit<ThreadMessage, 'createdAt'> & { createdAt?: string },
): void {
  internals.messages.push({
    ...message,
    createdAt: message.createdAt ?? new Date().toISOString(),
  });
}

/**
 * Render prior turns as a plain-text preamble to seed a fresh run with context.
 * Returns `undefined` when there is nothing to replay.
 */
export function renderThreadContext(
  messages: readonly ThreadMessage[],
): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  const lines = messages.map(message => {
    const speaker = message.role === 'user' ? 'User' : 'Assistant';
    const result =
      message.role === 'agent' && message.data !== undefined
        ? `\nResult: ${JSON.stringify(message.data)}`
        : '';
    return `${speaker}: ${message.content}${result}`;
  });
  return `Conversation so far:\n${lines.join('\n')}`;
}
