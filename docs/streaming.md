# Streaming

`agent.stream()` is `run()` with a live text feed. It returns immediately with
two things:

```ts
const { textStream, result } = agent.stream({ prompt: 'Explain the plan.' });

for await (const delta of textStream) {
  process.stdout.write(delta); // tokens as the model produces them
}

const final = await result; // the same RunResult run() would return
```

- `textStream` is an `AsyncIterable<string>` of the model's text deltas.
- `result` is a promise for the final `RunResult`. Always await it, even if you
  only need the stream. Awaiting it finalizes the turn, surfaces errors, and
  commits conversation state when using a thread. The final result also
  carries [`usage`](./api.md#runusage) with the run's token counts and
  estimated cost.

## With and without a schema

Streaming works for both run shapes:

```ts
// Chat turn: the stream IS the reply.
const chat = agent.stream({ prompt, thread });

// Structured task: the stream is progress narration; await result for data.
const task = agent.stream({ prompt, schema });
for await (const delta of task.textStream) ui.showThinking(delta);
const { data } = await task.result; // validated payload
```

## Zero-glue chat frontends

`toUIMessageStreamResponse()` returns the run as an [AI SDK UI Message
Stream](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) SSE response, the
wire format consumed by AI SDK's `useChat` and
[assistant-ui](https://www.assistant-ui.com)'s `useChatRuntime`. Combined
with `messages` input, a chat route handler is one statement (see the
[assistant-ui](./integrations/assistant-ui.md) and
[AI SDK UI](./integrations/ai-sdk-ui.md) integration pages for the full
setup):

```ts
export async function POST(req: Request): Promise<Response> {
  const { messages } = await req.json();
  return agent
    .stream({ messages, signal: req.signal })
    .toUIMessageStreamResponse();
}
```

```tsx
// assistant-ui
const runtime = useChatRuntime(); // default transport posts to /api/chat
// or AI SDK
const { messages } = useChat();
```

The stream carries text and reasoning deltas, tool calls and results, step
boundaries per model turn, and a final `finish` chunk whose
`messageMetadata` includes the run's `usage`, so the UI can show per-message
token counts and cost. Failures arrive as an in-band `error`
chunk. `toUIMessageStream()` exposes the same chunks as an async iterable
for custom transports.

`messages` accepts the AI SDK `UIMessage` shape (`role` plus `text` parts):
the last message must be a user message and becomes the prompt; earlier
user/assistant turns are replayed as conversation context. For durable
server-side history, prefer [threads](./threads.md) and `prompt`.

### Wire-level controls

`toUIMessageStreamResponse` and `toUIMessageStream` accept options mirroring
the AI SDK's. They decide what leaves the server: hiding data in the
frontend is not redaction, because anything sent is visible in the browser's
network inspector.

```ts
return agent.stream({ messages }).toUIMessageStreamResponse({
  sendReasoning: false, // keep the model's thinking server-side
  sendTools: {
    queryBilling: false, // hidden entirely
    weather: 'names-only', // tool shown, input/output sent as null
    // unlisted tools stream in full
  },
  onError: error => 'Something went wrong.', // optional; masked by default
});
```

| Option          | Default                         | Description                                                                                |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `sendReasoning` | `true`                          | Stream reasoning deltas to the client.                                                     |
| `sendTools`     | `true`                          | `true`, `false`, `'names-only'`, or a per-tool record of those values.                     |
| `onError`       | masked (`"An error occurred."`) | Maps a failed run to the `error` chunk's text. Server error details never leak by default. |

Standard `ResponseInit` fields (`status`, `statusText`, `headers`) are also
accepted by `toUIMessageStreamResponse`.

## Piping to a browser (SSE)

For a custom protocol, `textStream` maps directly onto a web-standard
`ReadableStream`:

```ts
export async function POST(req: Request): Promise<Response> {
  const { prompt } = await req.json();
  const { textStream, result } = agent.stream({ prompt });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const delta of textStream) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(delta)}\n\n`),
        );
      }
      await result;
      controller.close();
    },
  });

  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
```

The full server pattern, with threads and persistence, is in
[Building a chat agent](./chat-agent.md).

## Run events

`textStream` carries text only. Agent-level and per-run `events` callbacks deliver tool calls, tool results,
file changes, repairs, and errors during streamed and non-streamed runs:

```ts
const agent = createAgent({
  model,
  events: {
    onToolCall: call => ui.showTool(call.name),
    onFileChange: file => ui.showFile(file.path),
  },
});
```

See [Files, tools, and events](./files-tools-events.md) for the full list.

## Errors

If the run fails, `textStream` still ends normally and `result` rejects with
the same failure object delivered to `onError`. Handle errors where you `await
result`; a `try`/`catch` around only the `for await` loop is not enough.
Use `getRunUsage(error)` to discover reconciled token and cost usage on
failures after a session starts. Preflight and session or extension
initialization failures occur before measurable work and do not carry usage.
