# assistant-ui

[assistant-ui](https://www.assistant-ui.com) renders runcell agents with zero
glue: runcell speaks the AI SDK UI Message Stream protocol that assistant-ui's
`useChatRuntime` consumes.

## Backend

One route handler:

```ts
// app/api/chat/route.ts
import { createAgent } from 'runcell';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  tools: {
    /* host tools */
  },
});

export async function POST(req: Request): Promise<Response> {
  const { messages } = await req.json();
  return agent
    .stream({ messages, signal: req.signal })
    .toUIMessageStreamResponse();
}
```

## Frontend

Follow assistant-ui's [getting started](https://www.assistant-ui.com/docs)
for components and styling. The runtime side is the default AI SDK setup:

```tsx
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useChatRuntime } from '@assistant-ui/react-ai-sdk';

export function Chat() {
  const runtime = useChatRuntime(); // posts to /api/chat by default
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* assistant-ui components, e.g. <Thread /> */}
    </AssistantRuntimeProvider>
  );
}
```

## What renders

- **Text and reasoning** stream live. assistant-ui shows reasoning as a
  collapsible block.
- **Tool calls** appear as tool parts and change to `output-available` when
  the tool returns. Register per-tool UI components in assistant-ui to
  customize rendering. Runcell-internal tools (`submitResult`, `fileChange`)
  never reach the wire.
- **Repair turns** arrive as additional steps of the same assistant message.
- **Usage** (token counts, `costUsd`, `costMeasured`) rides the finish
  chunk's `messageMetadata`, so the UI can show per-message cost.
- **Failures** end the stream with an in-band `error` chunk. The message is
  masked by default (see below).
- **Attachments** on the sent message (file parts with data URLs) are seeded
  into the run workspace under `attachments/`, and the agent reads them with
  its file tools. With the optional peers `pdfjs-dist` and `@napi-rs/canvas`
  installed, PDF attachments get a built-in `readPdfPages` tool that renders
  pages as images the model can view. See
  [messages input](../streaming.md#zero-glue-chat-frontends) for limits.

## Controlling what crosses the wire

Anything sent to the browser is visible in its network inspector, regardless
of what the UI renders. Redaction therefore happens server-side, on the
response:

```ts
return agent.stream({ messages }).toUIMessageStreamResponse({
  sendReasoning: false,
  sendTools: { queryBilling: false, weather: 'names-only' },
  onError: () => 'Something went wrong.',
});
```

See [wire-level controls](../streaming.md#wire-level-controls) for the full
option reference.

## Server-side conversation state

`messages` replays the client-held history on every request, which suits
assistant-ui's default model. To keep durable server-side state instead, use
[threads](../threads.md) with `prompt` and persist `thread.toJSON()`. The
[chat agent guide](../chat-agent.md) shows the full pattern.
