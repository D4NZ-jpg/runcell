# AI SDK UI (useChat)

Runcell speaks the [AI SDK UI Message
Stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) protocol, so
`useChat` consumes a runcell agent exactly as it consumes a `streamText`
backend — no adapter.

## Backend

```ts
// app/api/chat/route.ts
import { createAgent } from 'runcell';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

export async function POST(req: Request): Promise<Response> {
  const { messages } = await req.json();
  return agent
    .stream({ messages, signal: req.signal })
    .toUIMessageStreamResponse();
}
```

## Frontend

```tsx
import { useChat } from '@ai-sdk/react';

export function Chat() {
  const { messages, sendMessage } = useChat(); // posts to /api/chat by default
  return (
    <>
      {messages.map(message => (
        <div key={message.id}>
          {message.parts.map((part, i) =>
            part.type === 'text' ? <span key={i}>{part.text}</span> : null,
          )}
        </div>
      ))}
    </>
  );
}
```

Messages carry the full part structure: `text`, `reasoning`, and `tool-*`
parts (with `input`/`output` and state transitions), plus
`message.metadata` with the run's `usage` — token counts, `costUsd`, and
`costMeasured` — and `sessionId` from the finish chunk.

## Controlling what crosses the wire

`toUIMessageStreamResponse` accepts the same option names as the AI SDK's,
plus tool redaction:

```ts
return agent.stream({ messages }).toUIMessageStreamResponse({
  sendReasoning: false, // keep thinking server-side
  sendTools: 'names-only', // tool names without payloads
  onError: error => 'Something went wrong.', // masked by default
});
```

See [wire-level controls](../streaming.md#wire-level-controls) for the full
option reference, and [threads](../threads.md) for durable server-side
conversation state as an alternative to replaying `messages`.
