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
 * Opaque, self-contained continuation state for lossless resume. Carries the
 * (compressed) engine journal so a thread can resume its exact conversation in
 * any sandbox, independent of where it originally ran. Never inspect this;
 * render {@link ThreadMessage}s instead.
 */
export interface ThreadContinuation {
  /** Engine that produced the journal. */
  engine: string;
  /** Engine-specific resume descriptor, passed back verbatim on resume. */
  resume: unknown;
  /** Base64 of the gzipped engine journal. */
  journalGz: string;
}

/**
 * The serializable form of a {@link Thread}. Persist this wherever you like and
 * rebuild with {@link threadFromJSON}.
 */
export interface ThreadState {
  version: 1;
  id: string;
  messages: ThreadMessage[];
  continuation?: ThreadContinuation;
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
  continuation: ThreadContinuation | undefined;
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
    return structuredClone({
      version: 1 as const,
      id: this.id,
      messages: this.state.messages,
      ...(this.state.continuation !== undefined
        ? { continuation: this.state.continuation }
        : {}),
    });
  }
}

/** Create a new, empty conversation thread. */
export function createThread(options: { id?: string } = {}): Thread {
  const state: ThreadInternalState = { messages: [], continuation: undefined };
  const thread = new ThreadHandle(options.id ?? randomUUID(), state);
  internalsRegistry.set(thread, state);
  return thread;
}

/** Rebuild a thread from a previously serialized {@link ThreadState}. */
export function threadFromJSON(state: ThreadState): Thread {
  const internal: ThreadInternalState = structuredClone({
    messages: state.messages,
    continuation: state.continuation,
  });
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
  // Deep-copied so callers mutating the recorded payload (e.g. result.data)
  // afterwards cannot rewrite conversation history.
  internals.messages.push(
    structuredClone({
      ...message,
      createdAt: message.createdAt ?? new Date().toISOString(),
    }),
  );
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
